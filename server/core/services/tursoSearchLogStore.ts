import { createClient, type Client } from "@libsql/client";

/**
 * Turso 搜索明细日志存储（2026-08-25 用户拍板）
 *
 * 背景：已能通过 openid 区分个体 + 已记录搜索词，但二者没有关联，
 * 无法排查"哪个 openid 搜了什么"。新建独立明细表 search_log：
 *   - 每次搜索一条：openid / ip / term / created_at
 *   - openid 原文存储（管理侧排查用，不进前端）
 *   - 90 天自动清理（隐私最小化 + 防表膨胀）
 *
 * 与 search_terms（聚合统计）解耦：search_terms 继续匿名聚合，明细
 * 日志单独成表，不污染统计口径。
 *
 * 保留策略（2026-08-25 用户拍板）：**长期保留**，不设自动清理——
 * 热词/日历按天 GROUP BY 本表明细即得"每天每词次数"，需要全量历史。
 * 数据量估算：日 2-3k 次搜索 ≈ 百万行/年，Turso 免费额度（5 亿行读/月）
 * 足够。若未来撑不住，再启用 pruneExpired 补清理/归档（方法已保留）。
 *
 * 表结构：
 *   search_log(
 *     id INTEGER PRIMARY KEY AUTOINCREMENT,
 *     openid TEXT NOT NULL DEFAULT '',   -- wxauth 解出的 openid（未登录为 ''）
 *     ip TEXT NOT NULL DEFAULT '',       -- 来源 IP（未知为 ''）
 *     term TEXT NOT NULL,                -- 搜索词
 *     created_at INTEGER NOT NULL        -- 时间戳（ms）
 *   )
 */

/**
 * 明细保留策略：**长期保留**（2026-08-25 用户拍板，热词/日历需要全量历史）。
 * 不再自动清理；pruneExpired 保留方法，未来撑不住时手动/定时补清理。
 */

export class TursoSearchLogStore {
  private client: Client;
  private initPromise: Promise<void> | null = null;
  private initFailed = false;

  constructor(url?: string, authToken?: string) {
    const u = url ?? process.env.TURSO_URL;
    const t = authToken ?? process.env.TURSO_AUTH_TOKEN;
    if (!u) {
      throw new Error("TursoSearchLogStore: 缺少 TURSO_URL 配置");
    }
    this.client = createClient({ url: u, authToken: t || undefined });
    this.initPromise = this.init()
      .then(() => {
        this.initPromise = null;
      })
      .catch((err) => {
        console.log(
          "[TursoSearchLogStore] ❌ 初始化失败:",
          err instanceof Error ? err.message : err
        );
        this.initFailed = true;
        this.initPromise = null;
        throw err;
      });
  }

  private async init(): Promise<void> {
    await this.client.batch([
      `CREATE TABLE IF NOT EXISTS search_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        openid TEXT NOT NULL DEFAULT '',
        ip TEXT NOT NULL DEFAULT '',
        term TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS idx_search_log_created ON search_log(created_at)",
    ]);
    console.log("[TursoSearchLogStore] ✅ 存储已就绪");
  }

  private async waitForInit(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
      this.initPromise = null;
    }
    if (this.initFailed) {
      throw new Error("TursoSearchLogStore 初始化失败");
    }
  }

  /** 写入一条搜索明细（异步，调用方失败静默，绝不影响搜索主流程） */
  async logSearch(input: {
    openid?: string;
    ip?: string;
    term: string;
    now?: number;
  }): Promise<void> {
    await this.waitForInit();
    await this.client.execute(
      "INSERT INTO search_log (openid, ip, term, created_at) VALUES (?, ?, ?, ?)",
      [
        (input.openid || "").slice(0, 128),
        (input.ip || "").slice(0, 64),
        input.term.slice(0, 200),
        input.now ?? Date.now(),
      ]
    );
  }

  /**
   * 清理超过保留期的明细（默认 90 天），返回删除条数。
   * 当前策略为长期保留（用户拍板），此方法仅在需要时手动/定时调用。
   */
  async pruneExpired(now: number, retainMs: number = 90 * 24 * 60 * 60_000): Promise<number> {
    await this.waitForInit();
    const result = await this.client.execute(
      "DELETE FROM search_log WHERE created_at <= ?",
      [now - retainMs]
    );
    return result.rowsAffected ?? 0;
  }

  close(): void {
    try {
      this.client.close();
    } catch {}
  }
}

let storeInstance: TursoSearchLogStore | null = null;

/**
 * 获取单例 store。Turso 不可用（未配 TURSO_URL）返回 null，
 * 调用方静默跳过明细记录（不影响搜索）。
 */
export function getSearchLogStore(): TursoSearchLogStore | null {
  if (storeInstance === null) {
    try {
      storeInstance = new TursoSearchLogStore();
    } catch {
      storeInstance = null;
    }
  }
  return storeInstance;
}

/** 测试用：重置单例 */
export function resetSearchLogStore(): void {
  storeInstance = null;
}
