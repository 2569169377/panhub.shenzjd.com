import type { IHotSearchStore, HotSearchItem, HotSearchStats, TrendingItem, TopTerm } from "./hotSearchStore";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loggers } from "../utils/logger";

const MAX_ENTRIES = 30;
const DEFAULT_DB_DIR = "./data";
const DEFAULT_DB_PATH = "./data/hot-searches.db";
/**
 * 热度衰减系数（/天）：score = score × e^(-λ×间隔天数) + 1
 * λ=1.0 → 半衰期约 17 小时，保证"近期热度"快速体现，旧词自然退场，新词有上升通道
 */
const LAMBDA = 1.0;
/** 热搜只展示最近 N 天内有搜索记录的词（配合 λ=1.0，3 天后热度基本归零） */
const HOT_WINDOW_DAYS = 3;

/** 本地时区日期键 YYYY-MM-DD（对齐用户感知的"今日"） */
function formatDateKey(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isForbidden(term: string): boolean {
  const forbiddenPatterns = [
    /政治|暴力|色情|赌博|毒品/i,
    /fuck|shit|bitch/i,
  ];
  return forbiddenPatterns.some((pattern) => pattern.test(term));
}

function normalize(term: string): string | null {
  let t = term.trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return null;
  if (t.length > 20) return null;
  t = t.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)
  );
  return t || null;
}

/**
 * SQLite 热搜存储实现（sql.js 纯 JS 版本）
 * 无需 native 编译，Docker/CF Workers/Node 均可运行
 */
export class SqliteHotSearchStore implements IHotSearchStore {
  private db: any;
  private dbPath: string;
  private dbDir: string;
  private isInitialized = false;
  private initFailed = false;
  private initPromise: Promise<void> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || DEFAULT_DB_PATH;
    this.dbDir = this.dbPath.substring(0, this.dbPath.lastIndexOf("/")) || DEFAULT_DB_DIR;
    this.initPromise = this.init()
      .then(() => {
        this.isInitialized = true;
        this.initPromise = null;
      })
      .catch((err) => {
        console.log("[SqliteHotSearchStore] ❌ 初始化失败:", err instanceof Error ? err.message : err);
        this.initFailed = true;
        this.initPromise = null;
        throw err;
      });
  }

  private async init(): Promise<void> {
    const initSqlJs = (await import("sql.js")).default;
    const SQL = await initSqlJs({
      locateFile: (file: string) => resolve(process.cwd(), "node_modules/sql.js/dist", file),
    });

    if (!existsSync(this.dbDir)) {
      mkdirSync(this.dbDir, { recursive: true });
    }

    // 从文件加载已有数据，或创建新数据库
    if (existsSync(this.dbPath)) {
      const buffer = readFileSync(this.dbPath);
      this.db = new SQL.Database(buffer);
    } else {
      this.db = new SQL.Database();
    }

    this.db.run(`
      CREATE TABLE IF NOT EXISTS hot_searches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        term TEXT NOT NULL UNIQUE,
        score INTEGER NOT NULL DEFAULT 1,
        last_searched_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_score ON hot_searches(score DESC)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_last_searched ON hot_searches(last_searched_at DESC)");

    // 全量搜索词库（联想补全 + 智能化原料，不清理）
    this.db.run(`
      CREATE TABLE IF NOT EXISTS search_terms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        term TEXT NOT NULL UNIQUE,
        count INTEGER NOT NULL DEFAULT 1,
        first_at INTEGER NOT NULL,
        last_at INTEGER NOT NULL
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_search_terms_count ON search_terms(count DESC)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_search_terms_last ON search_terms(last_at DESC)");

    // 每日榜单快照（飙升榜计算基础，懒生成）
    this.db.run(`
      CREATE TABLE IF NOT EXISTS rank_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snap_date TEXT NOT NULL,
        term TEXT NOT NULL,
        rank INTEGER NOT NULL,
        score REAL NOT NULL,
        UNIQUE(snap_date, term)
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_snapshots_date ON rank_snapshots(snap_date)");

    // 迁移 JSON 数据
    this.migrateFromJson();
    // 从日志初始化词库（仅词库为空时执行，纯新增不影响热榜）
    this.seedSearchTermsFromLogs();

    this.saveToDisk();
    console.log("[SqliteHotSearchStore] ✅ SQLite (sql.js) 存储已初始化");
  }

  private migrateFromJson(): void {
    if (this.dbPath !== DEFAULT_DB_PATH) return;
    const JSON_PATH = "./data/hot-searches.json";
    try {
      if (!existsSync(JSON_PATH)) return;

      const raw = readFileSync(JSON_PATH, "utf-8");
      const data = JSON.parse(raw);
      if (!data?.items?.length) return;

      const result = this.db.exec("SELECT COUNT(*) as c FROM hot_searches");
      const count = result[0]?.values[0]?.[0] ?? 0;
      if (count > 0) return;

      const stmt = this.db.prepare("INSERT OR IGNORE INTO hot_searches (term, score, last_searched_at, created_at) VALUES (?, ?, ?, ?)");
      for (const item of data.items) {
        const normalized = normalize(item.term);
        if (normalized && !isForbidden(normalized)) {
          stmt.run([normalized, item.score || 1, item.lastSearched || Date.now(), item.createdAt || Date.now()]);
        }
      }
      stmt.free();
      this.saveToDisk();
      console.log(`[SqliteHotSearchStore] ✅ 从 JSON 迁移了 ${data.items.length} 条数据`);
    } catch {}
  }

  /**
   * 从 data/*.log 中解析历史"新词出现"记录，初始化词库表
   * 仅在词库为空时执行（幂等），纯新增不影响热榜数据
   */
  private seedSearchTermsFromLogs(): void {
    try {
      const result = this.db.exec("SELECT COUNT(*) as c FROM search_terms");
      if (result[0]?.values[0]?.[0] > 0) return;

      if (!existsSync(this.dbDir)) return;
      const logs = readdirSync(this.dbDir).filter((f) => f.endsWith(".log"));
      if (logs.length === 0) return;

      const countMap = new Map<string, number>();
      const re = /新词出现[\s\S]*?"term": "([^"]+)"/g;
      for (const file of logs) {
        const content = readFileSync(resolve(this.dbDir, file), "utf-8");
        let m: RegExpExecArray | null;
        while ((m = re.exec(content)) !== null) {
          const term = m[1];
          if (!term) continue;
          countMap.set(term, (countMap.get(term) ?? 0) + 1);
        }
      }
      if (countMap.size === 0) return;

      const now = Date.now();
      const stmt = this.db.prepare("INSERT OR IGNORE INTO search_terms (term, count, first_at, last_at) VALUES (?, ?, ?, ?)");
      for (const [term, count] of countMap) {
        stmt.run([term, count, now, now]);
      }
      stmt.free();
      this.saveToDisk();
      console.log(`[SqliteHotSearchStore] ✅ 从日志初始化词库 ${countMap.size} 条`);
    } catch {}
  }

  // 热路径（每 500ms 防抖触发）：异步写入避免阻塞事件循环
  private saveToDisk(): void {
    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      writeFile(this.dbPath, buffer).catch(() => {});
    } catch {}
  }

  // 同步写入：仅用于 close() 等需要确保数据落盘的场景
  private saveToDiskSync(): void {
    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      writeFileSync(this.dbPath, buffer);
    } catch {}
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveToDisk(), 500);
  }

  private async waitForInit(): Promise<void> {
    if (this.isInitialized) return;
    if (this.initFailed) return;
    if (this.initPromise) await this.initPromise;
  }

  async recordSearch(term: string, now: number): Promise<void> {
    await this.waitForInit();
    const normalized = normalize(term);
    if (!normalized) return;
    if (isForbidden(normalized)) return;

    const existing = this.db.exec("SELECT score, last_searched_at FROM hot_searches WHERE term = ?", [normalized]);
    if (existing.length > 0 && existing[0].values.length > 0) {
      const prevScore = existing[0].values[0][0] as number;
      const prevTime = existing[0].values[0][1] as number;
      // 指数加权：旧热度先按间隔衰减，再 +1，避免历史累计分数永久霸榜
      const elapsedDays = (now - prevTime) / 86400000;
      const newScore = prevScore * Math.exp(-LAMBDA * elapsedDays) + 1;
      this.db.run("UPDATE hot_searches SET score = ?, last_searched_at = ? WHERE term = ?", [newScore, now, normalized]);
    } else {
      this.db.run("INSERT INTO hot_searches (term, score, last_searched_at, created_at) VALUES (?, 1, ?, ?)", [normalized, now, now]);
      // 观测日志：新词首次出现（驱动热搜产品观察的关键信号）
      loggers.hotSearch.info("新词出现", { term: normalized });
    }

    // 词库表：全量搜索词 + 计数（联想补全 / 飙升 / 未来智能化）
    const termRow = this.db.exec("SELECT count FROM search_terms WHERE term = ?", [normalized]);
    if (termRow.length > 0 && termRow[0].values.length > 0) {
      this.db.run("UPDATE search_terms SET count = count + 1, last_at = ? WHERE term = ?", [now, normalized]);
    } else {
      this.db.run("INSERT INTO search_terms (term, count, first_at, last_at) VALUES (?, 1, ?, ?)", [normalized, now, now]);
    }

    this.cleanupOldEntries(MAX_ENTRIES);
    this.scheduleSave();
  }

  async getHotSearches(limit: number): Promise<HotSearchItem[]> {
    await this.waitForInit();
    const now = Date.now();
    const cutoff = now - HOT_WINDOW_DAYS * 86400000;
    const result = this.db.exec(`
      SELECT term, score, last_searched_at, created_at,
        score * exp(-${LAMBDA} * ((${now} - last_searched_at) / 86400000.0)) as decayed_score
      FROM hot_searches
      WHERE last_searched_at >= ${cutoff}
      ORDER BY decayed_score DESC, last_searched_at DESC
      LIMIT ${Math.min(limit, MAX_ENTRIES)}
    `);

    if (!result.length) return [];
    const cols = result[0].columns;
    return result[0].values.map((row: any[], index: number) => {
      const obj: any = {};
      cols.forEach((col: string, i: number) => obj[col] = row[i]);
      return {
        term: obj.term,
        score: obj.score,
        lastSearched: obj.last_searched_at,
        createdAt: obj.created_at,
        rank: index + 1,
        displayScore: Math.round(obj.decayed_score * 100) / 100,
      };
    });
  }

  cleanupOldEntries(maxEntries: number): void {
    // 清理超过 HOT_WINDOW_DAYS 天未搜索的旧词，释放空间
    const now = Date.now();
    const cutoff = now - HOT_WINDOW_DAYS * 86400000;
    this.db.run(`
      DELETE FROM hot_searches WHERE last_searched_at < ?
    `, [cutoff]);
    // 保留最多 maxEntries 条记录
    this.db.run(`
      DELETE FROM hot_searches WHERE id NOT IN (
        SELECT id FROM hot_searches ORDER BY score DESC, last_searched_at DESC LIMIT ?
      )
    `, [maxEntries]);
  }

  async clearHotSearches(): Promise<{ success: boolean; message: string }> {
    await this.waitForInit();
    this.db.run("DELETE FROM hot_searches");
    this.saveToDisk();
    return { success: true, message: "热搜记录已清除" };
  }

  async deleteHotSearch(term: string): Promise<{ success: boolean; message: string }> {
    await this.waitForInit();
    const before = this.db.exec("SELECT COUNT(*) as c FROM hot_searches WHERE term = ?", [term]);
    const had = before[0]?.values[0]?.[0] ?? 0;
    this.db.run("DELETE FROM hot_searches WHERE term = ?", [term]);
    if (had > 0) {
      this.saveToDisk();
      return { success: true, message: `热搜词 "${term}" 已删除` };
    }
    return { success: false, message: "热搜词不存在" };
  }

  async getStats(): Promise<HotSearchStats> {
    await this.waitForInit();
    const result = this.db.exec("SELECT COUNT(*) as c FROM hot_searches");
    const total = result[0]?.values[0]?.[0] ?? 0;
    const topTerms = await this.getHotSearches(10);
    return { total, topTerms };
  }

  getDbSize(): number {
    try {
      if (existsSync(this.dbPath)) {
        const { statSync } = require("node:fs");
        return Math.round((statSync(this.dbPath).size / (1024 * 1024)) * 100) / 100;
      }
    } catch {}
    return 0;
  }

  async getTopTerms(limit: number): Promise<TopTerm[]> {
    await this.waitForInit();
    const safeLimit = Math.min(Math.max(1, limit), 50000);
    const result = this.db.exec(
      `SELECT term, count FROM search_terms
       WHERE count >= 2 AND length(term) >= 2
       ORDER BY count DESC, last_at DESC
       LIMIT ${safeLimit}`
    );
    if (!result.length) return [];
    const cols = result[0].columns;
    return result[0].values.map((row: any[]) => {
      const obj: any = {};
      cols.forEach((col: string, i: number) => (obj[col] = row[i]));
      return { term: obj.term, count: obj.count };
    });
  }

  async ensureTodaySnapshot(): Promise<void> {
    await this.waitForInit();
    const date = formatDateKey(Date.now());
    const existing = this.db.exec("SELECT COUNT(*) as c FROM rank_snapshots WHERE snap_date = ?", [date]);
    if (existing[0]?.values[0]?.[0] > 0) return;

    const items = await this.getHotSearches(MAX_ENTRIES);
    const stmt = this.db.prepare("INSERT OR REPLACE INTO rank_snapshots (snap_date, term, rank, score) VALUES (?, ?, ?, ?)");
    items.forEach((item, index) => {
      stmt.run([date, item.term, index + 1, item.displayScore ?? item.score]);
    });
    stmt.free();
    this.scheduleSave();
  }

  async getTrending(limit: number): Promise<TrendingItem[]> {
    await this.waitForInit();
    await this.ensureTodaySnapshot();

    const today = formatDateKey(Date.now());
    const yesterday = formatDateKey(Date.now() - 86400000);

    const todayResult = this.db.exec(
      "SELECT term, rank FROM rank_snapshots WHERE snap_date = ? ORDER BY rank ASC",
      [today]
    );
    const todayRows = todayResult.length
      ? todayResult[0].values.map((row: any[]) => ({ term: row[0] as string, rank: row[1] as number }))
      : [];

    const yestResult = this.db.exec(
      "SELECT term, rank FROM rank_snapshots WHERE snap_date = ?",
      [yesterday]
    );
    const prevRankMap = new Map<string, number>();
    if (yestResult.length) {
      for (const row of yestResult[0].values) {
        prevRankMap.set(row[0] as string, row[1] as number);
      }
    }

    const items: TrendingItem[] = todayRows.map((row) => {
      const prevRank = prevRankMap.get(row.term) ?? null;
      return {
        term: row.term,
        rank: row.rank,
        prevRank,
        // 新上榜视为最大飙升（delta 取当前排名，越小越靠前）
        delta: prevRank === null ? row.rank : prevRank - row.rank,
        score: 0,
      };
    });

    // 新上榜优先（按当前排名升序），其余按上升幅度降序
    items.sort((a, b) => {
      const aNew = a.prevRank === null;
      const bNew = b.prevRank === null;
      if (aNew && bNew) return a.rank - b.rank;
      if (aNew) return -1;
      if (bNew) return 1;
      if (b.delta !== a.delta) return b.delta - a.delta;
      return a.rank - b.rank;
    });

    return items.slice(0, Math.min(Math.max(1, limit), 100));
  }

  close(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.db) {
      this.saveToDiskSync(); // 同步写入确保数据落盘后再关闭
      this.db.close();
    }
  }
}
