import type { H3Event } from "h3";
import { getRequestHeader } from "h3";
import { createClient, type Client } from "@libsql/client";
import { randomBytes } from "node:crypto";
import { loggers } from "../core/utils/logger";

/**
 * 小程序登录 token 签发/校验/吊销（2026-08-28 新增）
 *
 * 背景：公众号 openid 与小程序 openid 不是同一个（个人订阅号未认证，
 * 拿不到 unionid），无法打通。小程序走独立的 wx.login → code2session
 * 登录流程，后端用小程序自己的 appid+secret 换 openid，签发 token。
 *
 * token 存 Turso（复用现有基础设施），自签自存自校验，零远程调用。
 *
 * 与公众号认证（wx-auth 项目）完全隔离：
 * - 公众号 openid → 存在 wx-auth 项目
 * - 小程序 openid → 存在本项目 mp_token 表
 * 两套独立，物理隔离，不会混淆。
 *
 * 表结构：
 *   mp_token(
 *     token TEXT PRIMARY KEY,        -- 随机 32 字节 hex
 *     openid TEXT NOT NULL,          -- 小程序 openid
 *     created_at INTEGER NOT NULL,   -- 签发时间戳（ms）
 *     expires_at INTEGER NOT NULL,   -- 过期时间戳（ms）
 *     revoked INTEGER NOT NULL DEFAULT 0  -- 0=有效，1=已吊销
 *   )
 */

/** token 有效期 7 天（小程序用户登录频率低，7 天合理） */
const TOKEN_TTL_MS = 7 * 24 * 60 * 60_000;

export class MpTokenStore {
  private client: Client;
  private initPromise: Promise<void> | null = null;
  private initFailed = false;

  constructor(url?: string, authToken?: string) {
    const u = url ?? process.env.TURSO_URL;
    const t = authToken ?? process.env.TURSO_AUTH_TOKEN;
    if (!u) {
      throw new Error("MpTokenStore: 缺少 TURSO_URL 配置");
    }
    this.client = createClient({ url: u, authToken: t || undefined });
    this.initPromise = this.init()
      .then(() => {
        this.initPromise = null;
      })
      .catch((err) => {
        console.log(
          "[MpTokenStore] ❌ 初始化失败:",
          err instanceof Error ? err.message : err
        );
        this.initFailed = true;
        this.initPromise = null;
        throw err;
      });
  }

  private async init(): Promise<void> {
    await this.client.batch([
      `CREATE TABLE IF NOT EXISTS mp_token (
        token TEXT PRIMARY KEY,
        openid TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0
      )`,
      "CREATE INDEX IF NOT EXISTS idx_mp_token_openid ON mp_token(openid)",
      "CREATE INDEX IF NOT EXISTS idx_mp_token_expires ON mp_token(expires_at)",
    ]);
    console.log("[MpTokenStore] ✅ 存储已就绪");
  }

  private async waitForInit(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
      this.initPromise = null;
    }
    if (this.initFailed) {
      throw new Error("MpTokenStore 初始化失败");
    }
  }

  /**
   * 签发 token（绑定小程序 openid）。
   * 返回随机 32 字节 hex token 字符串。
   */
  async signToken(openid: string, now: number = Date.now()): Promise<string> {
    await this.waitForInit();
    const token = randomBytes(32).toString("hex");
    await this.client.execute(
      "INSERT INTO mp_token (token, openid, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)",
      [token, openid.slice(0, 128), now, now + TOKEN_TTL_MS]
    );
    return token;
  }

  /**
   * 校验 token 有效性。
   * 有效条件：存在 + 未过期（expires_at > now）+ 未吊销（revoked = 0）。
   * 返回 { valid, openid? }：有效时带 openid 供搜索日志关联。
   */
  async verifyToken(
    token: string,
    now: number = Date.now()
  ): Promise<{ valid: boolean; openid?: string }> {
    await this.waitForInit();
    const r = (
      await this.client.execute(
        "SELECT openid, expires_at, revoked FROM mp_token WHERE token = ?",
        [token]
      )
    ).rows[0];
    if (!r) return { valid: false };
    const expiresAt = (r.expires_at as number) ?? 0;
    const revoked = (r.revoked as number) ?? 0;
    if (revoked === 1) return { valid: false };
    if (expiresAt <= now) return { valid: false };
    return { valid: true, openid: r.openid as string };
  }

  /** 吊销单个 token（泄露时即时生效，无需小程序发版） */
  async revokeToken(token: string): Promise<boolean> {
    await this.waitForInit();
    const result = await this.client.execute(
      "UPDATE mp_token SET revoked = 1 WHERE token = ? AND revoked = 0",
      [token]
    );
    return (result.rowsAffected ?? 0) > 0;
  }

  /** 吊销某 openid 的所有 token（一键吊销某用户所有会话） */
  async revokeByOpenid(openid: string): Promise<number> {
    await this.waitForInit();
    const result = await this.client.execute(
      "UPDATE mp_token SET revoked = 1 WHERE openid = ? AND revoked = 0",
      [openid]
    );
    return result.rowsAffected ?? 0;
  }

  /** 清理过期 token（定期维护用，不阻塞主流程） */
  async pruneExpired(now: number = Date.now()): Promise<number> {
    await this.waitForInit();
    const result = await this.client.execute(
      "DELETE FROM mp_token WHERE expires_at <= ?",
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

let storeInstance: MpTokenStore | null = null;

/**
 * 获取单例 store。Turso 不可用（未配 TURSO_URL）返回 null，
 * 调用方 fail-closed（拒绝请求，宁可不可用，不裸奔）。
 */
export function getMpTokenStore(): MpTokenStore | null {
  if (storeInstance === null) {
    try {
      storeInstance = new MpTokenStore();
    } catch {
      storeInstance = null;
    }
  }
  return storeInstance;
}

/** 测试用：重置单例 */
export function resetMpTokenStore(): void {
  storeInstance = null;
}

/**
 * 从请求头提取 Bearer token 并校验。
 *
 * 供 requireWxAuth 调用：小程序请求带 Authorization: Bearer <token>，
 * 本函数校验 token 有效性。有效 → { valid: true, openid }；
 * 无效/无 token / Turso 不可用 → { valid: false }。
 */
export async function verifyMpBearerToken(
  event: H3Event
): Promise<{ valid: boolean; openid?: string }> {
  const auth = getRequestHeader(event, "authorization");
  if (!auth || !auth.startsWith("Bearer ")) return { valid: false };
  const token = auth.slice(7).trim();
  if (!token) return { valid: false };
  const store = getMpTokenStore();
  if (!store) {
    loggers.search.warn("MpTokenStore 不可用，Bearer 校验 fail-closed");
    return { valid: false };
  }
  return store.verifyToken(token);
}
