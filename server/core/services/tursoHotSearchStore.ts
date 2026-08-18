import { createClient, type Client } from "@libsql/client";
import type { IHotSearchStore, HotSearchItem, HotSearchStats, TopTerm, DaySnapshot, DayTerm } from "./hotSearchStore";
import { loggers } from "../utils/logger";
import { normalize, isForbidden, formatDateKey, beijingDayStart } from "./hotSearchUtils";

/**
 * Turso 热搜存储实现（libSQL / SQLite fork，HTTP 驱动）
 *
 * 与 SqliteHotSearchStore / D1HotSearchStore 语义完全对齐（同一套 SQL + 共享工具函数），
 * 供迁移到 Turso 使用：Worker 与 Docker 两侧都通过 @libsql/client 走 HTTP 读写同一份数据。
 * 相比 D1 免费档（5M 行读/天、100K 行写/天），Turso Free 提供 5 亿行读/月、1000 万行写/月，
 * 且超额为软限制（继续运行、按量计费），不会直接失败。
 *
 * 配置（环境变量，缺失时构造函数抛错，由工厂回退 sqlite）：
 *   TURSO_URL           libsql://xxx.turso.io（或 file: 本地库，测试用）
 *   TURSO_AUTH_TOKEN    Turso 数据库 auth token
 */
const LAMBDA = 1.0;
const HOT_WINDOW_DAYS = 1;
const MAX_ENTRIES = 30;

export class TursoHotSearchStore implements IHotSearchStore {
  private client: Client;
  private initPromise: Promise<void> | null = null;
  private initFailed = false;

  constructor(url?: string, authToken?: string) {
    const u = url ?? process.env.TURSO_URL;
    const t = authToken ?? process.env.TURSO_AUTH_TOKEN;
    if (!u) {
      throw new Error("TursoHotSearchStore: 缺少 TURSO_URL 配置");
    }
    this.client = createClient({ url: u, authToken: t || undefined });
    this.initPromise = this.init()
      .then(() => {
        this.initPromise = null;
      })
      .catch((err) => {
        console.log(
          "[TursoHotSearchStore] ❌ 初始化失败:",
          err instanceof Error ? err.message : err
        );
        this.initFailed = true;
        this.initPromise = null;
        throw err;
      });
  }

  private async init(): Promise<void> {
    await this.client.batch([
      `CREATE TABLE IF NOT EXISTS hot_searches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        term TEXT NOT NULL UNIQUE,
        score INTEGER NOT NULL DEFAULT 1,
        last_searched_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS idx_score ON hot_searches(score DESC)",
      "CREATE INDEX IF NOT EXISTS idx_last_searched ON hot_searches(last_searched_at DESC)",
      `CREATE TABLE IF NOT EXISTS search_terms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        term TEXT NOT NULL UNIQUE,
        count INTEGER NOT NULL DEFAULT 1,
        first_at INTEGER NOT NULL,
        last_at INTEGER NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS idx_search_terms_last ON search_terms(last_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_search_terms_count ON search_terms(count DESC)",
    ]);
    console.log("[TursoHotSearchStore] ✅ Turso 存储已就绪");
  }

  private async waitForInit(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
      this.initPromise = null;
    }
    if (this.initFailed) {
      throw new Error("TursoHotSearchStore 初始化失败");
    }
  }

  async recordSearch(term: string, now: number, delta = 1): Promise<void> {
    await this.waitForInit();
    const normalized = normalize(term);
    if (!normalized) return;
    if (isForbidden(normalized)) return;
    const d = Math.max(1, delta);

    const existing = (
      await this.client.execute(
        "SELECT score, last_searched_at FROM hot_searches WHERE term = ?",
        [normalized]
      )
    ).rows[0];

    if (existing) {
      const prevScore = existing.score as number;
      const prevTime = existing.last_searched_at as number;
      const elapsedDays = (now - prevTime) / 86400000;
      const newScore = prevScore * Math.exp(-LAMBDA * elapsedDays) + d;
      await this.client.execute(
        "UPDATE hot_searches SET score = ?, last_searched_at = ? WHERE term = ?",
        [newScore, now, normalized]
      );
      loggers.hotSearch.info("搜索词", { term: normalized, isNew: false });
    } else {
      await this.client.execute(
        "INSERT INTO hot_searches (term, score, last_searched_at, created_at) VALUES (?, ?, ?, ?)",
        [normalized, d, now, now]
      );
      loggers.hotSearch.info("搜索词", { term: normalized, isNew: true });
    }

    const termRow = (
      await this.client.execute(
        "SELECT count FROM search_terms WHERE term = ?",
        [normalized]
      )
    ).rows[0];
    if (termRow) {
      await this.client.execute(
        "UPDATE search_terms SET count = count + ?, last_at = ? WHERE term = ?",
        [d, now, normalized]
      );
    } else {
      await this.client.execute(
        "INSERT INTO search_terms (term, count, first_at, last_at) VALUES (?, ?, ?, ?)",
        [normalized, d, now, now]
      );
    }

    await this.cleanupOldEntries(MAX_ENTRIES);
  }

  async getHotSearches(limit: number): Promise<HotSearchItem[]> {
    await this.waitForInit();
    const now = Date.now();
    const cutoff = now - HOT_WINDOW_DAYS * 86400000;
    const safeLimit = Math.min(Math.max(1, limit), MAX_ENTRIES);
    const rows = (
      await this.client.execute(
        `SELECT term, score, last_searched_at, created_at,
          score * exp(-${LAMBDA} * ((${now} - last_searched_at) / 86400000.0)) as decayed_score
         FROM hot_searches
         WHERE last_searched_at >= ${cutoff}
         ORDER BY decayed_score DESC, last_searched_at DESC
         LIMIT ${safeLimit}`
      )
    ).rows;

    return rows.map((obj, index) => ({
      term: obj.term as string,
      score: obj.score as number,
      lastSearched: obj.last_searched_at as number,
      createdAt: obj.created_at as number,
      rank: index + 1,
      displayScore: Math.round((obj.decayed_score as number) * 100) / 100,
    }));
  }

  async getRandomHotSearches(limit: number): Promise<HotSearchItem[]> {
    await this.waitForInit();
    const dayStart = beijingDayStart(formatDateKey(Date.now()));
    const safeLimit = Math.min(Math.max(1, limit), 100);
    const rows = (
      await this.client.execute(
        `SELECT term, count, first_at, last_at FROM search_terms
         WHERE last_at >= ?
         ORDER BY RANDOM()
         LIMIT ?`,
        [dayStart, safeLimit]
      )
    ).rows;

    const out: HotSearchItem[] = [];
    for (const obj of rows) {
      if (isForbidden(obj.term as string)) continue;
      out.push({
        term: obj.term as string,
        score: obj.count as number,
        lastSearched: obj.last_at as number,
        createdAt: obj.first_at as number,
        rank: out.length + 1,
        displayScore: obj.count as number,
      });
    }
    return out;
  }

  async cleanupOldEntries(maxEntries: number): Promise<void> {
    await this.waitForInit();
    const now = Date.now();
    const cutoff = now - HOT_WINDOW_DAYS * 86400000;
    await this.client.execute(
      "DELETE FROM hot_searches WHERE last_searched_at < ?",
      [cutoff]
    );
    await this.client.execute(
      `DELETE FROM hot_searches WHERE id NOT IN (
        SELECT id FROM hot_searches ORDER BY score DESC, last_searched_at DESC LIMIT ?
      )`,
      [Math.max(1, maxEntries)]
    );
  }

  async clearHotSearches(): Promise<{ success: boolean; message: string }> {
    await this.waitForInit();
    await this.client.execute("DELETE FROM hot_searches");
    return { success: true, message: "热搜记录已清除" };
  }

  async deleteHotSearch(term: string): Promise<{ success: boolean; message: string }> {
    await this.waitForInit();
    const before = (
      await this.client.execute(
        "SELECT COUNT(*) as c FROM hot_searches WHERE term = ?",
        [term]
      )
    ).rows[0];
    const had = (before?.c ?? 0) as number;
    await this.client.execute("DELETE FROM hot_searches WHERE term = ?", [term]);
    if (had > 0) {
      return { success: true, message: `热搜词 "${term}" 已删除` };
    }
    return { success: false, message: "热搜词不存在" };
  }

  async getStats(): Promise<HotSearchStats> {
    await this.waitForInit();
    const row = (
      await this.client.execute("SELECT COUNT(*) as c FROM hot_searches")
    ).rows[0];
    const total = (row?.c ?? 0) as number;
    const topTerms = await this.getHotSearches(10);
    return { total, topTerms };
  }

  async getTopTerms(limit: number): Promise<TopTerm[]> {
    await this.waitForInit();
    const safeLimit = Math.min(Math.max(1, limit), 50000);
    const rows = (
      await this.client.execute(
        `SELECT term, count FROM search_terms
         WHERE count >= 2 AND length(term) >= 2
         ORDER BY count DESC, last_at DESC
         LIMIT ?`,
        [safeLimit]
      )
    ).rows;
    return rows.map((obj) => ({ term: obj.term as string, count: obj.count as number }));
  }

  async getCalendar(days: number): Promise<DaySnapshot[]> {
    await this.waitForInit();
    const safeDays = Math.min(Math.max(1, days), 90);
    const startTs = beijingDayStart(formatDateKey(Date.now())) - (safeDays - 1) * 86400000;

    const countRows = (
      await this.client.execute(
        `SELECT date((last_at + 8*3600*1000) / 1000, 'unixepoch') as day, COUNT(*) as c
         FROM search_terms
         WHERE last_at >= ?
         GROUP BY day`,
        [startTs]
      )
    ).rows;
    const countMap = new Map<string, number>();
    for (const row of countRows) {
      countMap.set(row.day as string, row.c as number);
    }

    const topRows = (
      await this.client.execute(
        `SELECT day, term FROM (
           SELECT date((last_at + 8*3600*1000) / 1000, 'unixepoch') as day, term, count, last_at,
                  ROW_NUMBER() OVER (PARTITION BY date((last_at + 8*3600*1000) / 1000, 'unixepoch') ORDER BY count DESC, last_at DESC) as rn
           FROM search_terms
           WHERE last_at >= ?
         ) WHERE rn <= 3`,
        [startTs]
      )
    ).rows;
    const topMap = new Map<string, string[]>();
    for (const row of topRows) {
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
    const rows = (
      await this.client.execute(
        `SELECT term, count, last_at FROM search_terms
         WHERE last_at >= ? AND last_at < ?
         ORDER BY count DESC, last_at DESC`,
        [start, end]
      )
    ).rows;
    return rows.map((obj, index) => ({
      term: obj.term as string,
      rank: index + 1,
      count: obj.count as number,
    }));
  }

  close(): void {
    try {
      this.client.close();
    } catch {}
  }
}

/**
 * 创建 Turso 热搜存储
 * 配置缺失时抛错（工厂层捕获后回退 sqlite）
 */
export function createTursoHotSearchStore(
  url?: string,
  authToken?: string
): TursoHotSearchStore {
  return new TursoHotSearchStore(url, authToken);
}
