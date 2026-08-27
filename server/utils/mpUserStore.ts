import type { H3Event } from "h3";
import { createClient, type Client } from "@libsql/client";
import { verifyMpBearerToken } from "./mpToken";

/**
 * 小程序用户资料存储（2026-08-28 新增）
 *
 * mp_user 表存头像 + 昵称，openid 为主键（一个小程序用户一行）。
 * 头像为 base64（data URL），个人小程序量级下体积可控
 * （chooseAvatar 原图约 40KB，压缩后 10~30KB）。
 *
 * 表结构：
 *   mp_user(
 *     openid TEXT PRIMARY KEY,
 *     nickname TEXT NOT NULL DEFAULT '',        -- 昵称（≤30 字）
 *     avatar TEXT NOT NULL DEFAULT '',          -- 头像 data URL（base64）
 *     unionid TEXT NOT NULL DEFAULT '',         -- 微信 unionid（个人订阅号未认证暂拿不到，先留空，为将来公众号/小程序账号关联铺路）
 *     updated_at INTEGER NOT NULL              -- 最后更新时间戳（ms）
 *   )
 */

/** 头像 base64 上限（含 data URL 前缀，约 256KB） */
const MAX_AVATAR_LENGTH = 256 * 1024;
/** 昵称长度上限 */
const MAX_NICKNAME_LENGTH = 30;

export interface MpUserProfile {
  openid: string;
  nickname: string;
  avatar: string;
  unionid: string;
  updatedAt: number;
}

export class MpUserStore {
  private client: Client;
  private initPromise: Promise<void> | null = null;
  private initFailed = false;

  constructor(url?: string, authToken?: string) {
    const u = url ?? process.env.TURSO_URL;
    const t = authToken ?? process.env.TURSO_AUTH_TOKEN;
    if (!u) {
      throw new Error("MpUserStore: 缺少 TURSO_URL 配置");
    }
    this.client = createClient({ url: u, authToken: t || undefined });
    this.initPromise = this.init()
      .then(() => {
        this.initPromise = null;
      })
      .catch((err) => {
        console.log(
          "[MpUserStore] ❌ 初始化失败:",
          err instanceof Error ? err.message : err
        );
        this.initFailed = true;
        this.initPromise = null;
        throw err;
      });
  }

  private async init(): Promise<void> {
    await this.client.execute(
      `CREATE TABLE IF NOT EXISTS mp_user (
        openid TEXT PRIMARY KEY,
        nickname TEXT NOT NULL DEFAULT '',
        avatar TEXT NOT NULL DEFAULT '',
        unionid TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      )`
    );
    console.log("[MpUserStore] ✅ 存储已就绪");
  }

  private async waitForInit(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
      this.initPromise = null;
    }
    if (this.initFailed) {
      throw new Error("MpUserStore 初始化失败");
    }
  }

  /** 读取用户资料；不存在返回 null */
  async get(openid: string): Promise<MpUserProfile | null> {
    await this.waitForInit();
    const r = (
      await this.client.execute(
        "SELECT nickname, avatar, unionid, updated_at FROM mp_user WHERE openid = ?",
        [openid.slice(0, 128)]
      )
    ).rows[0];
    if (!r) return null;
    return {
      openid,
      nickname: (r.nickname as string) ?? "",
      avatar: (r.avatar as string) ?? "",
      unionid: (r.unionid as string) ?? "",
      updatedAt: (r.updated_at as number) ?? 0,
    };
  }

  /** 更新（upsert）：只更新传入的非空字段，返回更新后的完整资料 */
  async upsert(
    openid: string,
    patch: { nickname?: string; avatar?: string }
  ): Promise<MpUserProfile> {
    await this.waitForInit();
    const now = Date.now();
    const o = openid.slice(0, 128);

    // 读旧值（不存在则空起步）
    const old = (await this.get(o)) ?? {
      openid: o,
      nickname: "",
      avatar: "",
      unionid: "",
      updatedAt: 0,
    };

    let nickname = old.nickname;
    if (typeof patch.nickname === "string") {
      nickname = patch.nickname.trim().slice(0, MAX_NICKNAME_LENGTH);
    }
    let avatar = old.avatar;
    if (typeof patch.avatar === "string") {
      if (patch.avatar.length > MAX_AVATAR_LENGTH) {
        throw new Error("avatar too large");
      }
      avatar = patch.avatar;
    }

    await this.client.execute(
      `INSERT INTO mp_user (openid, nickname, avatar, unionid, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(openid) DO UPDATE SET
         nickname = excluded.nickname,
         avatar = excluded.avatar,
         unionid = excluded.unionid,
         updated_at = excluded.updated_at`,
      [o, nickname, avatar, old.unionid, now]
    );

    return { openid: o, nickname, avatar, unionid: old.unionid, updatedAt: now };
  }
}

let storeInstance: MpUserStore | null = null;

/**
 * 获取单例 store。Turso 不可用（未配 TURSO_URL）返回 null，
 * 调用方 fail-closed。
 */
export function getMpUserStore(): MpUserStore | null {
  if (storeInstance === null) {
    try {
      storeInstance = new MpUserStore();
    } catch {
      storeInstance = null;
    }
  }
  return storeInstance;
}

/** 测试用：重置单例 */
export function resetMpUserStore(): void {
  storeInstance = null;
}

/**
 * 从请求头提取 Bearer token 对应的 openid（小程序登录态）。
 * 复用 mpToken 的校验（verifyMpBearerToken），无效/无 token 返回 null。
 */
export async function getOpenidFromBearer(
  event: H3Event
): Promise<string | null> {
  const { valid, openid } = await verifyMpBearerToken(event);
  return valid ? (openid ?? null) : null;
}
