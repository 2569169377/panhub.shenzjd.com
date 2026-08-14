import type { IHotSearchStore, HotSearchItem, HotSearchStats, TopTerm, DaySnapshot, DayTerm } from "./hotSearchStore";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, copyFileSync } from "node:fs";
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
      // 启动自愈：检测 db 损坏（旧版 fire-and-forget 写盘可能产生半写文件），
      // 能 REINDEX 修复就修复，修不好则备份坏库 + 空库重建（词库由日志 seed 回填）
      this.repairIfCorrupt(SQL);
    } else {
      this.db = new SQL.Database();
    }

    // 建表（init 与损坏重建共用同一套表结构）
    this.ensureTables();

    // 迁移 JSON 数据
    this.migrateFromJson();
    // 从日志初始化词库（仅词库为空时执行，纯新增不影响热榜）
    this.seedSearchTermsFromLogs();

    this.saveToDiskAtomic();
    console.log("[SqliteHotSearchStore] ✅ SQLite (sql.js) 存储已初始化");
  }

  /**
   * 启动自愈：检测 db 文件完整性
   * - PRAGMA quick_check 返回非 "ok" → 索引/页损坏（旧版异步写盘半写导致）
   * - 优先 REINDEX 修复（可救回绝大多数"索引错乱"型损坏）
   * - REINDEX 失败 → 备份坏库为 *.corrupt-{ts}，用空库重建（词库稍后由 seedSearchTermsFromLogs 回填）
   */
  private repairIfCorrupt(SQL: any): void {
    try {
      const check = this.db.exec("PRAGMA quick_check");
      const quickCheckResult = check?.[0]?.values?.[0]?.[0] as string | undefined;
      // quick_check 正常返回单行 "ok"
      if (quickCheckResult === "ok") return;

      console.warn(
        `[SqliteHotSearchStore] ⚠️ 检测到 db 完整性异常（${quickCheckResult ?? "unknown"}），尝试 REINDEX 修复`
      );

      // 1) 尝试 REINDEX 重建所有索引（对索引错乱型损坏有效）
      try {
        this.db.run("REINDEX");
        const recheck = this.db.exec("PRAGMA quick_check");
        if (recheck?.[0]?.values?.[0]?.[0] === "ok") {
          console.log("[SqliteHotSearchStore] ✅ REINDEX 修复成功");
          this.saveToDiskAtomic();
          return;
        }
      } catch (e) {
        console.warn("[SqliteHotSearchStore] ⚠️ REINDEX 修复失败:", e instanceof Error ? e.message : String(e));
      }

      // 2) REINDEX 无效 → 备份坏库后重建空库（数据由日志 seed 回填）
      this.backupAndRebuild(SQL);
    } catch (e) {
      // quick_check 本身都跑不起来（文件严重损坏 / 无法解析）→ 直接重建
      console.warn("[SqliteHotSearchStore] ⚠️ db 严重损坏，无法执行完整性检查，直接重建:", e instanceof Error ? e.message : String(e));
      this.backupAndRebuild(SQL);
    }
  }

  /** 备份损坏 db 文件并新建空库（数据后续由日志 seed / 实时搜索重建） */
  private backupAndRebuild(SQL: any): void {
    try {
      const backupPath = `${this.dbPath}.corrupt-${Date.now()}`;
      copyFileSync(this.dbPath, backupPath);
      console.warn(`[SqliteHotSearchStore] ⚠️ 已备份损坏库到 ${backupPath}，重建空库`);
    } catch (e) {
      console.warn("[SqliteHotSearchStore] ⚠️ 备份损坏库失败:", e instanceof Error ? e.message : String(e));
    }
    try {
      this.db?.close();
    } catch {}
    this.db = new SQL.Database();
    // 空库也需要建表（沿用 init 的表结构）
    this.ensureTables();
  }

  /** 建表（init 与 损坏重建共用） */
  private ensureTables(): void {
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
      this.saveToDiskAtomic();
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
      // 兼容旧格式「新词出现 {多行}」与新格式「搜索词 {"term":"..","isNew":..}」单行日志
      const re = /(?:新词出现|搜索词)[\s\S]*?"term":\s*"([^"]+)"/g;
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
      this.saveToDiskAtomic();
      console.log(`[SqliteHotSearchStore] ✅ 从日志初始化词库 ${countMap.size} 条`);
    } catch {}
  }

  // 热路径：原子写盘（tmp + rename，POSIX 上 OS 级原子替换，绝不会出现半写文件）
  // 旧的 fire-and-forget writeFile 在 dev server SIGINT/SIGKILL 时会导致 db 半写、
  // sql.js 加载报 "database disk image is malformed" 索引错乱。
  // 异常路径：atomic 失败时降级为直接覆盖写（保留数据），再失败才告警。
  private saveToDiskAtomic(): void {
    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      const tmpPath = `${this.dbPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeFileSync(tmpPath, buffer);
      // renameSync 在 Linux/macOS 是原子替换；极端 fs（如 NFS / 某些外置盘）不支持 → 走 fallback
      renameSync(tmpPath, this.dbPath);
    } catch (atomicErr) {
      try {
        // 降级：直接覆盖（可能产生半写但保留数据；除非同步断电，否则就是 OK）
        const data = this.db.export();
        writeFileSync(this.dbPath, Buffer.from(data));
      } catch (fallbackErr) {
        // 真兜不住：同时报原子失败 + 直写失败
        console.warn(
          "[SqliteHotSearchStore] ⚠️ 写盘失败（atomic 与 fallback 都失败，下次再重试）:",
          atomicErr instanceof Error ? atomicErr.message : atomicErr
        );
      }
    }
  }

  // 兼容性 sync 入口（close / 紧急刷盘场景）
  private saveToDiskSync(): void {
    this.saveToDiskAtomic();
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    // 防抖后同步原子写：500ms 内的多次 recordSearch 合并成一次落盘
    this.saveTimer = setTimeout(() => this.saveToDiskAtomic(), 500);
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
      // 搜索流水日志：每次搜索都记录（isNew=false 表示历史词）
      loggers.hotSearch.info("搜索词", { term: normalized, isNew: false });
    } else {
      this.db.run("INSERT INTO hot_searches (term, score, last_searched_at, created_at) VALUES (?, 1, ?, ?)", [normalized, now, now]);
      // 搜索流水日志：新词首次出现（驱动热搜产品观察的关键信号）
      loggers.hotSearch.info("搜索词", { term: normalized, isNew: true });
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
    this.saveToDiskAtomic();
    return { success: true, message: "热搜记录已清除" };
  }

  async deleteHotSearch(term: string): Promise<{ success: boolean; message: string }> {
    await this.waitForInit();
    const before = this.db.exec("SELECT COUNT(*) as c FROM hot_searches WHERE term = ?", [term]);
    const had = before[0]?.values[0]?.[0] ?? 0;
    this.db.run("DELETE FROM hot_searches WHERE term = ?", [term]);
    if (had > 0) {
      this.saveToDiskAtomic();
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
    // 每天访问时全量重建当天快照（幂等、始终最新），历史天不受影响
    const start = new Date(date + "T00:00:00").getTime();
    const end = start + 86400000;

    const result = this.db.exec(
      `SELECT term, count FROM search_terms
       WHERE last_at >= ? AND last_at < ?
       ORDER BY count DESC, last_at DESC`,
      [start, end]
    );
    const rows = result.length ? result[0].values : [];

    this.db.run("DELETE FROM rank_snapshots WHERE snap_date = ?", [date]);
    const stmt = this.db.prepare("INSERT OR REPLACE INTO rank_snapshots (snap_date, term, rank, score) VALUES (?, ?, ?, ?)");
    rows.forEach((row: any[], index: number) => {
      stmt.run([date, row[0], index + 1, row[1]]);
    });
    stmt.free();
    this.scheduleSave();
  }

  async getCalendar(days: number): Promise<DaySnapshot[]> {
    await this.waitForInit();
    const safeDays = Math.min(Math.max(1, days), 90);
    const start = formatDateKey(Date.now() - (safeDays - 1) * 86400000);

    const countResult = this.db.exec(
      `SELECT snap_date, COUNT(*) as c FROM rank_snapshots
       WHERE snap_date >= ?
       GROUP BY snap_date ORDER BY snap_date DESC`,
      [start]
    );
    const countMap = new Map<string, number>();
    if (countResult.length) {
      for (const row of countResult[0].values) {
        countMap.set(row[0] as string, row[1] as number);
      }
    }

    const topResult = this.db.exec(
      `SELECT snap_date, term FROM rank_snapshots
       WHERE snap_date >= ? AND rank <= 3
       ORDER BY snap_date, rank ASC`,
      [start]
    );
    const topMap = new Map<string, string[]>();
    if (topResult.length) {
      for (const row of topResult[0].values) {
        const date = row[0] as string;
        const list = topMap.get(date) ?? [];
        if (list.length < 3) list.push(row[1] as string);
        topMap.set(date, list);
      }
    }

    // 生成最近 safeDays 天的连续日期（含无数据的天）
    const out: DaySnapshot[] = [];
    for (let i = safeDays - 1; i >= 0; i--) {
      const date = formatDateKey(Date.now() - i * 86400000);
      out.push({
        date,
        count: countMap.get(date) ?? 0,
        top: topMap.get(date) ?? [],
      });
    }
    return out;
  }

  async getDayItems(date: string): Promise<DayTerm[]> {
    await this.waitForInit();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
    const result = this.db.exec(
      "SELECT term, rank, score FROM rank_snapshots WHERE snap_date = ? ORDER BY rank ASC",
      [date]
    );
    if (!result.length) return [];
    const cols = result[0].columns;
    return result[0].values.map((row: any[]) => {
      const obj: any = {};
      cols.forEach((col: string, i: number) => (obj[col] = row[i]));
      return { term: obj.term, rank: obj.rank, count: obj.score };
    });
  }

  close(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.db) {
      this.saveToDiskSync(); // 同步写入确保数据落盘后再关闭
      this.db.close();
    }
  }
}
