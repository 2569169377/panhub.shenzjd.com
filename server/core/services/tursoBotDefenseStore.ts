import { createClient, type Client } from "@libsql/client";

/**
 * Turso IP 黑名单存储（2026-08-24 用户拍板）
 *
 * 背景：分布式低频刷词攻击每个 IP 不到 60 req/min（限流中间件阈值），
 * 限流拦不住；多个真实浏览器 UA 绕过 requireHumanOrCredential 拦截；
 * 数据库 search_terms 不带 IP 列，无法事后查询攻击来源。
 *
 * 设计：以 Turso 单表 rejected_ips 作为持久化 IP 黑名单真源。
 * - recordRejection：记录一次"被拦截"，hit_count +1；
 *   service 层根据累积次数触发 extendBlock 拉入正式黑名单（延长 expires_at）
 * - extendBlock：黑名单动作，**分级递增**（2026-08-25 用户拍板）：
 *   block_count=1 → 24h；=2 → 7 天；>=3 → 30 天。
 *   block_count 跨周期保留（prune 不删惯犯条目），顽固爬虫越关越久。
 * - isBlocked：查 IP 是否还在封禁期内
 * - pruneExpired：只清理"从未被正式拉黑过（block_count=0）"的过期条目；
 *   惯犯档案永久保留，避免解封后又从 0 累计
 *
 * 不走 IHotSearchStore 接口（语义与热搜无关，独立维护），由 botDefense
 * service 封装后调用。Worker / Docker 双跑，自动从环境变量取连接信息。
 *
 * 表结构：
 *   rejected_ips(
 *     ip TEXT PRIMARY KEY,        -- IPv4 / IPv6 字符串（normalizeIp 规整后）
 *     first_at INTEGER NOT NULL,  -- 首次被 reject 的时间戳（ms）
 *     last_at INTEGER NOT NULL,   -- 最近一次被 reject 的时间戳（ms）
 *     hit_count INTEGER NOT NULL DEFAULT 1,
 *     reason TEXT NOT NULL,       -- 最近一次被拒原因：bot_ua / rate_limit / bad_term
 *     expires_at INTEGER NOT NULL -- 当前封禁到期时间戳（ms）
 *     block_count INTEGER NOT NULL DEFAULT 0 -- 被正式拉黑次数（分级递增依据，惯犯保留）
 *   )
 */

/** 单次被拒绝自动过期时间（首次累计期间短过期，给 1h 等待阈值判定） */
const HIT_TTL_MS = 60 * 60_000;
/** 分级封禁时长（按 block_count 取档：1→24h，2→7 天，>=3→30 天；2026-08-25 用户拍板） */
const BLOCK_DURATIONS_MS = [
  24 * 60 * 60_000,
  7 * 24 * 60 * 60_000,
  30 * 24 * 60 * 60_000,
];
/** 取封禁时长：blockCount>=1，越界取最长档 */
function blockDurationMs(blockCount: number): number {
  const idx = Math.min(Math.max(blockCount, 1), BLOCK_DURATIONS_MS.length) - 1;
  return BLOCK_DURATIONS_MS[idx];
}

export class TursoBotDefenseStore {
  private client: Client;
  private initPromise: Promise<void> | null = null;
  private initFailed = false;

  constructor(url?: string, authToken?: string) {
    const u = url ?? process.env.TURSO_URL;
    const t = authToken ?? process.env.TURSO_AUTH_TOKEN;
    if (!u) {
      throw new Error("TursoBotDefenseStore: 缺少 TURSO_URL 配置");
    }
    this.client = createClient({ url: u, authToken: t || undefined });
    this.initPromise = this.init()
      .then(() => {
        this.initPromise = null;
      })
      .catch((err) => {
        console.log(
          "[TursoBotDefenseStore] ❌ 初始化失败:",
          err instanceof Error ? err.message : err
        );
        this.initFailed = true;
        this.initPromise = null;
        throw err;
      });
  }

  private async init(): Promise<void> {
    await this.client.batch([
      `CREATE TABLE IF NOT EXISTS rejected_ips (
        ip TEXT PRIMARY KEY,
        first_at INTEGER NOT NULL,
        last_at INTEGER NOT NULL,
        hit_count INTEGER NOT NULL DEFAULT 1,
        reason TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        block_count INTEGER NOT NULL DEFAULT 0
      )`,
      "CREATE INDEX IF NOT EXISTS idx_rejected_ips_expires ON rejected_ips(expires_at)",
    ]);
    // 兼容旧表（无 block_count 列）：幂等补列（已存在时报 duplicate column，忽略）
    try {
      await this.client.execute(
        "ALTER TABLE rejected_ips ADD COLUMN block_count INTEGER NOT NULL DEFAULT 0"
      );
    } catch {
      // 列已存在（新表 CREATE 已带），忽略
    }
    console.log("[TursoBotDefenseStore] ✅ 存储已就绪");
  }

  private async waitForInit(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
      this.initPromise = null;
    }
    if (this.initFailed) {
      throw new Error("TursoBotDefenseStore 初始化失败");
    }
  }

  /**
   * 记录一次拒绝事件（不直接进黑名单，仅累计 hit_count）。
   * 已有条目：hit_count +1，更新 last_at / reason。
   * 新条目：写入，初始 expires_at = now + 1h（短过期，未达阈值会被 prune）
   *
   * 返回当前 hit_count 与「当前是否已经在正式封禁期内」（便于 service 层
   * 决定是否要触发 extendBlock）。
   */
  async recordRejection(
    ip: string,
    reason: string,
    now: number
  ): Promise<{ hitCount: number; blocked: boolean; blockCount: number }> {
    await this.waitForInit();
    const existing = (
      await this.client.execute(
        "SELECT hit_count, expires_at, block_count FROM rejected_ips WHERE ip = ?",
        [ip]
      )
    ).rows[0];

    if (existing) {
      const hitCount = ((existing.hit_count as number) ?? 0) + 1;
      await this.client.execute(
        "UPDATE rejected_ips SET hit_count = ?, last_at = ?, reason = ? WHERE ip = ?",
        [hitCount, now, reason, ip]
      );
      return {
        hitCount,
        blocked: ((existing.expires_at as number) ?? 0) > now,
        blockCount: ((existing.block_count as number) ?? 0) || 0,
      };
    }

    await this.client.execute(
      "INSERT INTO rejected_ips (ip, first_at, last_at, hit_count, reason, expires_at, block_count) VALUES (?, ?, ?, 1, ?, ?, 0)",
      [ip, now, now, reason, now + HIT_TTL_MS]
    );
    return { hitCount: 1, blocked: false, blockCount: 0 };
  }

  /**
   * 命中阈值后分级封禁（2026-08-25 用户拍板）：
   * block_count 递增 1，封禁时长按新值取档（1→24h，2→7 天，>=3→30 天）。
   * block_count 不因过期清零（prune 保留惯犯），顽固爬虫越关越久。
   * @returns 新 block_count（供 service 日志）
   */
  async extendBlock(
    ip: string,
    reason: string,
    now: number
  ): Promise<number> {
    await this.waitForInit();
    const existing = (
      await this.client.execute(
        "SELECT block_count FROM rejected_ips WHERE ip = ?",
        [ip]
      )
    ).rows[0];
    const nextBlockCount = (((existing?.block_count as number) ?? 0) || 0) + 1;
    const expiresAt = now + blockDurationMs(nextBlockCount);

    await this.client.execute(
      `INSERT INTO rejected_ips (ip, first_at, last_at, hit_count, reason, expires_at, block_count)
       VALUES (?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT(ip) DO UPDATE SET
         last_at = excluded.last_at,
         reason = excluded.reason,
         expires_at = excluded.expires_at,
         block_count = excluded.block_count`,
      [ip, now, now, reason, expiresAt, nextBlockCount]
    );
    return nextBlockCount;
  }

  /** 当前 IP 是否仍在封禁期内（expires_at > now） */
  async isBlocked(ip: string, now: number): Promise<boolean> {
    await this.waitForInit();
    const r = (
      await this.client.execute(
        "SELECT expires_at FROM rejected_ips WHERE ip = ?",
        [ip]
      )
    ).rows[0];
    if (!r) return false;
    return ((r.expires_at as number) ?? 0) > now;
  }

  /**
   * 清掉过期条目，返回删除条数（用于周期 prune）。
   * 只删"从未被正式拉黑过（block_count=0）"的过期条目——
   * 惯犯档案（block_count>0）永久保留，跨周期记住封禁历史，
   * 避免解封后再刷又从 0 累计、永远只吃 24h。
   */
  async pruneExpired(now: number): Promise<number> {
    await this.waitForInit();
    const result = await this.client.execute(
      "DELETE FROM rejected_ips WHERE expires_at <= ? AND block_count = 0",
      [now]
    );
    return result.rowsAffected ?? 0;
  }

  close(): void {
    try {
      this.client.close();
    } catch {}
  }
}

export function createTursoBotDefenseStore(
  url?: string,
  authToken?: string
): TursoBotDefenseStore {
  return new TursoBotDefenseStore(url, authToken);
}
