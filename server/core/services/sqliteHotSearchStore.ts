import type { IHotSearchStore, HotSearchItem, HotSearchStats, TopTerm, DaySnapshot, DayTerm } from "./hotSearchStore";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { loggers } from "../utils/logger";
import { normalize, isForbidden, formatDateKey, beijingDayStart } from "./hotSearchUtils";

// node:sqlite 不在 module.builtinModules 列表（Node 新内置模块漏注册），vite/vite-node 剥掉
// node: 前缀后会当成 npm 包 "sqlite" 解析失败；用 createRequire 走 Node CJS loader 原生解析，
// 拼接模块名避免任何静态分析（vitest 转换 & Nitro 打包都原样保留）
const require = createRequire(import.meta.url);
const sqliteModule = () => require("node:" + "sqlite") as { DatabaseSync: any };

const MAX_ENTRIES = 30;
const DEFAULT_DB_DIR = "./data";
const DEFAULT_DB_PATH = process.env.HOT_SEARCH_DB_PATH || "./data/hot-searches.db";

/**
 * SQLite 热搜存储实现（node:sqlite 内置模块版本）
 * SQLite 编译进 Node 二进制：零 native 编译、零 WASM、真文件持久化（写操作直接落盘，无需全量 export）
 * Node < 22.13 时动态 import 失败 → 由 HotSearchService 回退内存模式
 */
export class SqliteHotSearchStore implements IHotSearchStore {
  // DatabaseSync 实例；用 any 规避 @types/node 版本差异
  private db: any;
  private dbPath: string;
  private dbDir: string;
  private isInitialized = false;
  private initFailed = false;
  private initPromise: Promise<void> | null = null;

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
    // require("node:sqlite") 由 Node 原生解析（见文件顶部注释）
    const { DatabaseSync } = sqliteModule();

    if (!existsSync(this.dbDir)) {
      mkdirSync(this.dbDir, { recursive: true });
    }

    // 打开（或创建）数据库文件，写操作由 SQLite 事务直接落盘
    this.db = new DatabaseSync(this.dbPath);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS search_terms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        term TEXT NOT NULL UNIQUE,
        count INTEGER NOT NULL DEFAULT 1,
        first_at INTEGER NOT NULL,
        last_at INTEGER NOT NULL
      )
    `);
    // hot_searches 表已废弃（2026-08-18）：生产 API 全部只读 search_terms，
    // 热搜写入只落 search_terms 一张表（原双表每次搜索写 2 行 → 1 行，省一半写入配额）
    // 每日榜单快照（飙升榜计算基础，懒生成）已随飙升榜删除（1fc0f21），
    // 日历数据改为实时聚合 search_terms，不再需要快照表
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_search_terms_last ON search_terms(last_at DESC)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_search_terms_count ON search_terms(count DESC)");

    // 迁移 JSON 数据
    this.migrateFromJson();
    // 从日志初始化词库（仅词库为空时执行，纯新增不影响热榜）
    this.seedSearchTermsFromLogs();

    console.log("[SqliteHotSearchStore] ✅ SQLite (node:sqlite) 存储已初始化");
  }

  private migrateFromJson(): void {
    if (this.dbPath !== DEFAULT_DB_PATH) return;
    const JSON_PATH = "./data/hot-searches.json";
    try {
      if (!existsSync(JSON_PATH)) return;

      const raw = readFileSync(JSON_PATH, "utf-8");
      const data = JSON.parse(raw);
      if (!data?.items?.length) return;

      const row = this.db.prepare("SELECT COUNT(*) as c FROM search_terms").get() as any;
      if ((row?.c ?? 0) > 0) return;

      // JSON 热榜数据 → search_terms（score→count、lastSearched→last_at、createdAt→first_at）
      const stmt = this.db.prepare("INSERT OR IGNORE INTO search_terms (term, count, first_at, last_at) VALUES (?, ?, ?, ?)");
      for (const item of data.items) {
        const normalized = normalize(item.term);
        if (normalized && !isForbidden(normalized)) {
          stmt.run(normalized, item.score || 1, item.createdAt || Date.now(), item.lastSearched || Date.now());
        }
      }
      console.log(`[SqliteHotSearchStore] ✅ 从 JSON 迁移了 ${data.items.length} 条数据`);
    } catch {}
  }

  /**
   * 从 data/*.log 中解析历史"新词出现"记录，初始化词库表
   * 仅在词库为空时执行（幂等），纯新增不影响热榜数据
   */
  private seedSearchTermsFromLogs(): void {
    try {
      const row = this.db.prepare("SELECT COUNT(*) as c FROM search_terms").get() as any;
      if ((row?.c ?? 0) > 0) return;

      if (!existsSync(this.dbDir)) return;
      const logs = readdirSync(this.dbDir).filter((f) => f.endsWith(".log"));
      if (logs.length === 0) return;

      const countMap = new Map<string, number>();
      // 兼容旧格式「新词出现 {多行}」与新格式「搜索词 {"term":"..","isNew":..}」单行日志
      const re = /(?:新词出现|搜索词)[\s\S]*?"term":\s*"([^"]+)"/g;
      for (const file of logs) {
        const content = readFileSync(`${this.dbDir}/${file}`, "utf-8");
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
        stmt.run(term, count, now, now);
      }
      console.log(`[SqliteHotSearchStore] ✅ 从日志初始化词库 ${countMap.size} 条`);
    } catch {}
  }

  private async waitForInit(): Promise<void> {
    if (this.isInitialized) return;
    if (this.initFailed) return;
    if (this.initPromise) await this.initPromise;
  }

  async recordSearch(term: string, now: number, delta = 1): Promise<void> {
    await this.waitForInit();
    const normalized = normalize(term);
    if (!normalized) return;
    if (isForbidden(normalized)) return;
    const d = Math.max(1, delta);

    // 全量词库表：每次搜索 count + d、更新 last_at（hot_searches 表已废弃，只写这一张）
    const termRow = this.db.prepare("SELECT count FROM search_terms WHERE term = ?").get(normalized) as any;
    if (termRow) {
      this.db.prepare("UPDATE search_terms SET count = count + ?, last_at = ? WHERE term = ?").run(d, now, normalized);
      // 搜索流水日志：每次搜索都记录（isNew=false 表示历史词）
      loggers.hotSearch.info("搜索词", { term: normalized, isNew: false });
    } else {
      this.db.prepare("INSERT INTO search_terms (term, count, first_at, last_at) VALUES (?, ?, ?, ?)").run(normalized, d, now, now);
      // 搜索流水日志：新词首次出现（驱动热搜产品观察的关键信号）
      loggers.hotSearch.info("搜索词", { term: normalized, isNew: true });
    }
  }

  /**
   * 获取热搜列表（按搜索次数降序；hot_searches 表已废弃，从 search_terms 聚合）
   * 无生产调用方，保留接口语义：count 当 score，last_at 当 lastSearched
   */
  async getHotSearches(limit: number): Promise<HotSearchItem[]> {
    await this.waitForInit();
    const safeLimit = Math.min(Math.max(1, limit), MAX_ENTRIES);
    const rows = this.db.prepare(
      `SELECT term, count, first_at, last_at FROM search_terms
       ORDER BY count DESC, last_at DESC
       LIMIT ?`
    ).all(safeLimit) as any[];

    return rows.map((obj, index) => ({
      term: obj.term,
      score: obj.count,
      lastSearched: obj.last_at,
      createdAt: obj.first_at,
      rank: index + 1,
      displayScore: obj.count,
    }));
  }

  /**
   * 今日热搜词池随机抽样（首页词云展示用）
   * - 数据源：search_terms 全量词库（不清理，日均 1000~3000 词）
   * - 过滤：北京时间今日 0 点之后有搜索记录的词（保证"今天真实有人搜过"）
   * - 排序：RANDOM()，每次请求结果不同
   */
  async getRandomHotSearches(limit: number): Promise<HotSearchItem[]> {
    await this.waitForInit();
    const dayStart = beijingDayStart(formatDateKey(Date.now()));
    const safeLimit = Math.min(Math.max(1, limit), 100);
    const rows = this.db.prepare(
      `SELECT term, count, first_at, last_at FROM search_terms
       WHERE last_at >= ?
       ORDER BY RANDOM()
       LIMIT ?`
    ).all(dayStart, safeLimit) as any[];

    const out: HotSearchItem[] = [];
    for (const obj of rows) {
      if (isForbidden(obj.term)) continue;
      out.push({
        term: obj.term,
        score: obj.count,
        lastSearched: obj.last_at,
        createdAt: obj.first_at,
        rank: out.length + 1,
        displayScore: obj.count,
      });
    }
    return out;
  }

  cleanupOldEntries(maxEntries: number): void {
    // hot_searches 表已废弃，search_terms 是全量词库（不清理），此处 no-op 保持接口兼容
  }

  async clearHotSearches(): Promise<{ success: boolean; message: string }> {
    await this.waitForInit();
    this.db.exec("DELETE FROM search_terms");
    return { success: true, message: "热搜记录已清除" };
  }

  async deleteHotSearch(term: string): Promise<{ success: boolean; message: string }> {
    await this.waitForInit();
    const before = this.db.prepare("SELECT COUNT(*) as c FROM search_terms WHERE term = ?").get(term) as any;
    const had = before?.c ?? 0;
    this.db.prepare("DELETE FROM search_terms WHERE term = ?").run(term);
    if (had > 0) {
      return { success: true, message: `热搜词 "${term}" 已删除` };
    }
    return { success: false, message: "热搜词不存在" };
  }

  async getStats(): Promise<HotSearchStats> {
    await this.waitForInit();
    const row = this.db.prepare("SELECT COUNT(*) as c FROM search_terms").get() as any;
    const total = row?.c ?? 0;
    const topTerms = await this.getHotSearches(10);
    return { total, topTerms };
  }

  getDbSize(): number {
    try {
      if (existsSync(this.dbPath)) {
        return Math.round((statSync(this.dbPath).size / (1024 * 1024)) * 100) / 100;
      }
    } catch {}
    return 0;
  }

  async getTopTerms(limit: number): Promise<TopTerm[]> {
    await this.waitForInit();
    const safeLimit = Math.min(Math.max(1, limit), 50000);
    const rows = this.db.prepare(
      `SELECT term, count FROM search_terms
       WHERE count >= 2 AND length(term) >= 2
       ORDER BY count DESC, last_at DESC
       LIMIT ${safeLimit}`
    ).all() as any[];
    return rows.map((obj) => ({ term: obj.term, count: obj.count }));
  }

  /**
   * 日历：近 N 天每天词数与 top3（实时聚合 search_terms，不再依赖快照表）
   * 日期边界用北京时间（+8h），保证与用户感知的"今日"一致
   */
  async getCalendar(days: number): Promise<DaySnapshot[]> {
    await this.waitForInit();
    const safeDays = Math.min(Math.max(1, days), 90);
    const startTs = beijingDayStart(formatDateKey(Date.now())) - (safeDays - 1) * 86400000;

    // 每天词数（按北京时间分组）
    const countRows = this.db.prepare(
      `SELECT date((last_at + 8*3600*1000) / 1000, 'unixepoch') as day, COUNT(*) as c
       FROM search_terms
       WHERE last_at >= ?
       GROUP BY day`
    ).all(startTs) as any[];
    const countMap = new Map<string, number>();
    for (const row of countRows) {
      countMap.set(row.day as string, row.c as number);
    }

    // 每天 top3（按 count 降序，count 相同按 last_at 新者优先）
    const topRows = this.db.prepare(
      `SELECT day, term FROM (
         SELECT date((last_at + 8*3600*1000) / 1000, 'unixepoch') as day, term, count, last_at,
                ROW_NUMBER() OVER (PARTITION BY date((last_at + 8*3600*1000) / 1000, 'unixepoch') ORDER BY count DESC, last_at DESC) as rn
         FROM search_terms
         WHERE last_at >= ?
       ) WHERE rn <= 3`
    ).all(startTs) as any[];
    const topMap = new Map<string, string[]>();
    for (const row of topRows) {
      const day = row.day as string;
      const list = topMap.get(day) ?? [];
      if (list.length < 3) list.push(row.term as string);
      topMap.set(day, list);
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
    const start = beijingDayStart(date);
    const end = start + 86400000;
    const rows = this.db.prepare(
      `SELECT term, count, last_at FROM search_terms
       WHERE last_at >= ? AND last_at < ?
       ORDER BY count DESC, last_at DESC`
    ).all(start, end) as any[];
    return rows.map((obj, index) => ({ term: obj.term, rank: index + 1, count: obj.count }));
  }

  close(): void {
    if (this.db) {
      this.db.close();
    }
  }
}
