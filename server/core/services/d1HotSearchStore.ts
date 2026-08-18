import type { IHotSearchStore, HotSearchItem, HotSearchStats, TopTerm, DaySnapshot, DayTerm } from "./hotSearchStore";
import { loggers } from "../utils/logger";
import { normalize, isForbidden, formatDateKey, beijingDayStart } from "./hotSearchUtils";

/**
 * D1 热搜存储实现（Cloudflare Workers 侧）
 *
 * 与 SqliteHotSearchStore 语义完全对齐（同一套 SQL + 共享工具函数），
 * 供 Worker 部署使用：热搜数据落在 D1，Docker 侧（现状 sqlite）与 Worker 侧共享同一份数据。
 *
 * binding 获取方式：
 * - Nitro cloudflare preset 下，wrangler.toml 的 [[d1_databases]] binding 会挂到 process.env.DB
 * - 单元测试直接注入 mock D1 对象
 *
 * 注意 D1 限制：
 * - 单查询返回行数有限（保守按 1000 行处理，getTopTerms 内部 cap）
 * - 全部为异步 API（prepare/bind/all/first/run）
 */

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  all(...params: unknown[]): Promise<{ results: any[]; success: boolean }>;
  first(...params: unknown[]): Promise<any | null>;
  run(...params: unknown[]): Promise<{ success: boolean; meta?: any }>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  exec(sql: string): Promise<{ success: boolean; meta?: any }>;
  batch(statements: D1PreparedStatementLike[]): Promise<any[]>;
}

const MAX_ENTRIES = 30;
/**
 * 热度衰减系数（/天）：score = score × e^(-λ×间隔天数) + 1
 * λ=1.0 → 半衰期约 17 小时（与 sqlite 实现一致）
 */
const LAMBDA = 1.0;
/** 热搜只展示最近 1 天内有搜索记录的词 */
const HOT_WINDOW_DAYS = 1;
/** D1 单查询返回行数保守上限（sitemap 取词上限 1000，卡线通过；如需更大需分页） */
const D1_ROW_LIMIT = 1000;

/** 从 process.env.DB 获取 D1 binding（Nitro cloudflare preset 注入位置） */
export function getD1Binding(): D1DatabaseLike | null {
  return ((process.env as any).DB as D1DatabaseLike) ?? null;
}

export class D1HotSearchStore implements IHotSearchStore {
  private db: D1DatabaseLike;
  private initPromise: Promise<void> | null = null;
  private initFailed = false;

  constructor(db?: D1DatabaseLike) {
    this.db = db ?? getD1Binding();
    if (!this.db) {
      throw new Error("D1HotSearchStore: 未提供 D1 binding（process.env.DB 为空或未注入）");
    }
    this.initPromise = this.init()
      .then(() => {
        this.initPromise = null;
      })
      .catch((err) => {
        console.log("[D1HotSearchStore] ❌ 初始化失败:", err instanceof Error ? err.message : err);
        this.initFailed = true;
        this.initPromise = null;
        throw err;
      });
  }

  private async init(): Promise<void> {
    // 注意：真实 D1 的 exec() 不支持多语句字符串（会报 incomplete input），
    // 建表/索引必须用 batch() 逐条执行（batch 内事务性执行，支持 DDL）
    await this.db.batch([
      this.db.prepare(
        `CREATE TABLE IF NOT EXISTS hot_searches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          term TEXT NOT NULL UNIQUE,
          score INTEGER NOT NULL DEFAULT 1,
          last_searched_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        )`
      ),
      this.db.prepare("CREATE INDEX IF NOT EXISTS idx_score ON hot_searches(score DESC)"),
      this.db.prepare("CREATE INDEX IF NOT EXISTS idx_last_searched ON hot_searches(last_searched_at DESC)"),
      this.db.prepare(
        `CREATE TABLE IF NOT EXISTS search_terms (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          term TEXT NOT NULL UNIQUE,
          count INTEGER NOT NULL DEFAULT 1,
          first_at INTEGER NOT NULL,
          last_at INTEGER NOT NULL
        )`
      ),
      this.db.prepare("CREATE INDEX IF NOT EXISTS idx_search_terms_last ON search_terms(last_at DESC)"),
      this.db.prepare("CREATE INDEX IF NOT EXISTS idx_search_terms_count ON search_terms(count DESC)"),
    ]);
    console.log("[D1HotSearchStore] ✅ D1 存储已就绪");
  }

  private async waitForInit(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
      this.initPromise = null;
    }
    if (this.initFailed) {
      throw new Error("D1HotSearchStore 初始化失败");
    }
  }

  async recordSearch(term: string, now: number, delta = 1): Promise<void> {
    await this.waitForInit();
    const normalized = normalize(term);
    if (!normalized) return;
    if (isForbidden(normalized)) return;
    const d = Math.max(1, delta);

    const existing = await this.db
      .prepare("SELECT score, last_searched_at FROM hot_searches WHERE term = ?")
      .bind(normalized)
      .first();

    if (existing) {
      const prevScore = existing.score as number;
      const prevTime = existing.last_searched_at as number;
      const elapsedDays = (now - prevTime) / 86400000;
      const newScore = prevScore * Math.exp(-LAMBDA * elapsedDays) + d;
      await this.db
        .prepare("UPDATE hot_searches SET score = ?, last_searched_at = ? WHERE term = ?")
        .bind(newScore, now, normalized)
        .run();
      loggers.hotSearch.info("搜索词", { term: normalized, isNew: false });
    } else {
      await this.db
        .prepare("INSERT INTO hot_searches (term, score, last_searched_at, created_at) VALUES (?, ?, ?, ?)")
        .bind(normalized, d, now, now)
        .run();
      loggers.hotSearch.info("搜索词", { term: normalized, isNew: true });
    }

    const termRow = await this.db
      .prepare("SELECT count FROM search_terms WHERE term = ?")
      .bind(normalized)
      .first();
    if (termRow) {
      await this.db
        .prepare("UPDATE search_terms SET count = count + ?, last_at = ? WHERE term = ?")
        .bind(d, now, normalized)
        .run();
    } else {
      await this.db
        .prepare("INSERT INTO search_terms (term, count, first_at, last_at) VALUES (?, ?, ?, ?)")
        .bind(normalized, d, now, now)
        .run();
    }

    await this.cleanupOldEntries(MAX_ENTRIES);
  }

  async getHotSearches(limit: number): Promise<HotSearchItem[]> {
    await this.waitForInit();
    const now = Date.now();
    const cutoff = now - HOT_WINDOW_DAYS * 86400000;
    const safeLimit = Math.min(Math.max(1, limit), MAX_ENTRIES);
    const rows = await this.db
      .prepare(
        `SELECT term, score, last_searched_at, created_at,
          score * exp(-${LAMBDA} * ((${now} - last_searched_at) / 86400000.0)) as decayed_score
         FROM hot_searches
         WHERE last_searched_at >= ${cutoff}
         ORDER BY decayed_score DESC, last_searched_at DESC
         LIMIT ${safeLimit}`
      )
      .all();

    return rows.results.map((obj, index) => ({
      term: obj.term,
      score: obj.score,
      lastSearched: obj.last_searched_at,
      createdAt: obj.created_at,
      rank: index + 1,
      displayScore: Math.round(obj.decayed_score * 100) / 100,
    }));
  }

  async getRandomHotSearches(limit: number): Promise<HotSearchItem[]> {
    await this.waitForInit();
    const dayStart = beijingDayStart(formatDateKey(Date.now()));
    const safeLimit = Math.min(Math.max(1, limit), 100);
    const rows = await this.db
      .prepare(
        `SELECT term, count, first_at, last_at FROM search_terms
         WHERE last_at >= ${dayStart}
         ORDER BY RANDOM()
         LIMIT ${safeLimit}`
      )
      .all();

    const out: HotSearchItem[] = [];
    for (const obj of rows.results) {
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

  async cleanupOldEntries(maxEntries: number): Promise<void> {
    await this.waitForInit();
    const now = Date.now();
    const cutoff = now - HOT_WINDOW_DAYS * 86400000;
    await this.db
      .prepare("DELETE FROM hot_searches WHERE last_searched_at < ?")
      .bind(cutoff)
      .run();
    await this.db
      .prepare(
        `DELETE FROM hot_searches WHERE id NOT IN (
          SELECT id FROM hot_searches ORDER BY score DESC, last_searched_at DESC LIMIT ${Math.max(1, maxEntries)}
        )`
      )
      .run();
  }

  async clearHotSearches(): Promise<{ success: boolean; message: string }> {
    await this.waitForInit();
    await this.db.prepare("DELETE FROM hot_searches").run();
    return { success: true, message: "热搜记录已清除" };
  }

  async deleteHotSearch(term: string): Promise<{ success: boolean; message: string }> {
    await this.waitForInit();
    const before = await this.db
      .prepare("SELECT COUNT(*) as c FROM hot_searches WHERE term = ?")
      .bind(term)
      .first();
    const had = (before?.c ?? 0) as number;
    await this.db.prepare("DELETE FROM hot_searches WHERE term = ?").bind(term).run();
    if (had > 0) {
      return { success: true, message: `热搜词 "${term}" 已删除` };
    }
    return { success: false, message: "热搜词不存在" };
  }

  async getStats(): Promise<HotSearchStats> {
    await this.waitForInit();
    const row = await this.db.prepare("SELECT COUNT(*) as c FROM hot_searches").first();
    const total = (row?.c ?? 0) as number;
    const topTerms = await this.getHotSearches(10);
    return { total, topTerms };
  }

  async getCalendar(days: number): Promise<DaySnapshot[]> {
    await this.waitForInit();
    const safeDays = Math.min(Math.max(1, days), 90);
    const startTs = beijingDayStart(formatDateKey(Date.now())) - (safeDays - 1) * 86400000;

    const countRows = await this.db
      .prepare(
        `SELECT date((last_at + 8*3600*1000) / 1000, 'unixepoch') as day, COUNT(*) as c
         FROM search_terms
         WHERE last_at >= ${startTs}
         GROUP BY day`
      )
      .all();
    const countMap = new Map<string, number>();
    for (const row of countRows.results) {
      countMap.set(row.day as string, row.c as number);
    }

    const topRows = await this.db
      .prepare(
        `SELECT day, term FROM (
           SELECT date((last_at + 8*3600*1000) / 1000, 'unixepoch') as day, term, count, last_at,
                  ROW_NUMBER() OVER (PARTITION BY date((last_at + 8*3600*1000) / 1000, 'unixepoch') ORDER BY count DESC, last_at DESC) as rn
           FROM search_terms
           WHERE last_at >= ${startTs}
         ) WHERE rn <= 3`
      )
      .all();
    const topMap = new Map<string, string[]>();
    for (const row of topRows.results) {
      const day = row.day as string;
      const list = topMap.get(day) ?? [];
      if (list.length < 3) list.push(row.term as string);
      topMap.set(day, list);
    }

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
    const rows = await this.db
      .prepare(
        `SELECT term, count, last_at FROM search_terms
         WHERE last_at >= ? AND last_at < ?
         ORDER BY count DESC, last_at DESC`
      )
      .bind(start, end)
      .all();
    return rows.results.map((obj, index) => ({
      term: obj.term,
      rank: index + 1,
      count: obj.count,
    }));
  }

  async getTopTerms(limit: number): Promise<TopTerm[]> {
    await this.waitForInit();
    const safeLimit = Math.min(Math.max(1, limit), D1_ROW_LIMIT);
    const rows = await this.db
      .prepare(
        `SELECT term, count FROM search_terms
         WHERE count >= 2 AND length(term) >= 2
         ORDER BY count DESC, last_at DESC
         LIMIT ${safeLimit}`
      )
      .all();
    return rows.results.map((obj) => ({ term: obj.term, count: obj.count }));
  }

  close(): void {
    // D1 为托管服务，无需关闭连接
  }
}
