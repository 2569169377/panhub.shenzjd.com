import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { loggers } from "../utils/logger";

/**
 * 频道配置服务（2026-08-24）
 *
 * 频道清单加密（AES-256-GCM）存入 Turso channel_config 表，
 * 本服务启动/定期拉取最新版本并解密缓存，供搜索服务读取。
 *
 * 配置（环境变量）：
 *   TURSO_URL / TURSO_AUTH_TOKEN   Turso 连接（与热搜同库）
 *   CHANNEL_KEY                    64 位 hex（32 字节），加密/解密密钥
 *   CHANNELS_JSON                  （可选兜底）明文 JSON
 *   CHANNELS_KEYS                  （可选）频道配置分级 key1:grant1|key2:all
 *   CHANNELS_REMOTE_URL            （可选）远程频道配置源，缺省用内置默认地址
 *   CHANNELS_API_KEY               （可选）拉取远程配置的鉴权标识
 *
 * 加载顺序：Turso > CHANNELS_JSON > 远程频道配置源 > 空。
 * 加密说明：AES-256-GCM（认证加密）。密钥只存在于服务器环境变量。
 */

export interface ChannelConfig {
  version: number;
  priorityChannels: string[];
  defaultChannels: string[];
}

export interface ChannelConfigServiceOptions {
  tursoUrl?: string;
  authToken?: string;
  channelKey?: string;
  envJson?: string;
  /** 远程频道配置源（无本地配置时的兜底，见 loadFromRemote） */
  remoteUrl?: string;
  /** 拉取远程配置时的鉴权标识（可选） */
  remoteKey?: string;
  /** 频道配置分级（key → 数量或 "all"；例 key1:15|key2:all），见 resolveChannelGrant */
  channelsKeys?: string;
}

/**
 * 远程频道配置源默认地址（写死，部署方无需任何配置即可获得频道配置兜底）
 */
export const DEFAULT_CHANNELS_REMOTE_URL =
  "https://panhub.shenzjd.com/api/channels";

/**
 * AES-256-GCM 加密（供 sync 脚本侧保持一致的密文格式：iv.tag.data，均 base64）
 */
export function encryptChannelConfig(plain: string, keyHex: string): string {
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) {
    throw new Error("CHANNEL_KEY 必须是 64 位 hex（32 字节）");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString("base64"),
    tag.toString("base64"),
    encrypted.toString("base64"),
  ].join(".");
}

/**
 * AES-256-GCM 解密（与 encryptChannelConfig 对称）
 */
export function decryptChannelConfig(payload: string, keyHex: string): string {
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) {
    throw new Error("CHANNEL_KEY 必须是 64 位 hex（32 字节）");
  }
  const parts = payload.split(".");
  if (parts.length !== 3) {
    throw new Error("频道配置密文格式非法");
  }
  const [ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivB64, "base64")
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function toChannelConfig(parsed: any): ChannelConfig | null {
  if (!parsed || typeof parsed !== "object") return null;
  const pick = (key: string): string[] =>
    Array.isArray(parsed[key])
      ? parsed[key].filter((x: unknown) => typeof x === "string")
      : [];
  return {
    version: Number(parsed.version) || 0,
    priorityChannels: pick("priorityChannels"),
    defaultChannels: pick("defaultChannels"),
  };
}

export class ChannelConfigService {
  private config: ChannelConfig | null = null;
  private loadPromise: Promise<ChannelConfig | null> | null = null;
  private options: ChannelConfigServiceOptions;

  constructor(options: ChannelConfigServiceOptions = {}) {
    // remoteUrl 缺省时使用内置默认地址，部署方零配置即可获得频道配置兜底
    this.options = {
      ...options,
      remoteUrl: options.remoteUrl || DEFAULT_CHANNELS_REMOTE_URL,
    };
  }

  /**
   * 同步快照：优先内存缓存，其次 CHANNELS_JSON 兜底，都没有返回空配置。
   * 用于创建 SearchService 时注入频道（搜索请求前的 ensureLoaded 已保证有值）。
   */
  getSnapshot(): ChannelConfig {
    if (this.config) return { ...this.config };
    const fromEnv = this.parseEnvJson();
    if (fromEnv) return fromEnv;
    return { version: 0, priorityChannels: [], defaultChannels: [] };
  }

  /**
   * 确保频道配置已加载（幂等，并发去重）。
   *
   * 2026-08-24 用户拍板：频道清单几乎不变，**首次加载后永久缓存**，
   * 不再按 TTL 定期重拉 Turso（改频道需重启服务/重新部署生效）。
   * 首次加载失败（Turso 临时不可用）会在下次请求重试；成功后就固定。
   * 搜索 API 入口调用；Turso 不可用时静默降级到 env 兜底/空配置。
   */
  async ensureLoaded(): Promise<ChannelConfig> {
    if (this.config) return this.getSnapshot();
    if (!this.loadPromise) {
      this.loadPromise = this.load()
        .catch((err) => {
          loggers.search.error("频道配置加载失败", {
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        })
        .finally(() => {
          this.loadPromise = null;
        });
    }
    await this.loadPromise;
    return this.getSnapshot();
  }

  /**
   * 频道配置下发（取 defaultChannels 前 N 个；priority 频道即使同时
   * 出现在 default 中也剔除，不随下发暴露）。用于 /api/channels。
   */
  getGrantedChannels(limit: number): { version: number; channels: string[] } {
    const snap = this.getSnapshot();
    const safeLimit = Math.max(0, Math.floor(limit));
    const prioritySet = new Set(snap.priorityChannels);
    const granted = snap.defaultChannels.filter(
      (channel) => !prioritySet.has(channel)
    );
    return {
      version: snap.version,
      channels: granted.slice(0, safeLimit),
    };
  }

  /**
   * 频道配置分级解析。
   * CHANNELS_KEYS 格式：`key1:grant1|key2:grant2`（用 | 分隔、key:grant 配对，
   * 避免特殊字符在 .env 解析时被破坏）。grant 支持数字或 "all"（全部 default 频道）。
   *
   * - 无 key / key 未注册 / 未配置 → defaultLimit
   * - key 对应数值 → 该数；key 对应 "all" → 全部 defaultChannels 数量
   * - 非法值 → 回落 defaultLimit
   */
  resolveChannelGrant(
    apiKey: string | null | undefined,
    defaultLimit: number
  ): number {
    const fallback = Math.max(0, Math.floor(defaultLimit));
    if (!apiKey) return fallback;
    const keysRaw = this.options.channelsKeys;
    if (!keysRaw) return fallback;
    try {
      const grant = this.parseGrantValue(keysRaw, apiKey);
      if (grant == null) return fallback;
      if (String(grant).toLowerCase() === "all") {
        return this.getSnapshot().defaultChannels.length;
      }
      const n = Number(grant);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
    } catch {
      return fallback;
    }
  }

  private parseGrantValue(keysRaw: string, apiKey: string): string | null {
    // 兼容 JSON 格式（历史配置）：{"keyA":"15","keyB":"all"}
    const trimmed = keysRaw.trim();
    if (trimmed.startsWith("{")) {
      try {
        const map = JSON.parse(trimmed);
        const v = map[apiKey];
        return v == null ? null : String(v);
      } catch {
        return null;
      }
    }
    // 推荐格式：key1:grant1|key2:grant2
    for (const pair of trimmed.split("|")) {
      const idx = pair.indexOf(":");
      if (idx <= 0) continue;
      const k = pair.slice(0, idx).trim();
      if (k === apiKey) return pair.slice(idx + 1).trim() || null;
    }
    return null;
  }

  private async load(): Promise<ChannelConfig | null> {
    // 1. Turso 加密配置（生产主路径）
    const fromTurso = await this.loadFromTurso();
    if (fromTurso) {
      this.config = fromTurso;
            loggers.search.info("频道配置已从 Turso 加载", { version: fromTurso.version });
      return fromTurso;
    }
    // 2. CHANNELS_JSON 兜底（本地 dev / 服务器 .env）
    const fromEnv = this.parseEnvJson();
    if (fromEnv) {
      this.config = fromEnv;
            loggers.search.warn("频道配置来自 CHANNELS_JSON 兜底", { version: fromEnv.version });
      return fromEnv;
    }
    // 3. 远程频道源兜底
    const fromRemote = await this.loadFromRemote();
    if (fromRemote) {
      this.config = fromRemote;
            loggers.search.warn("频道配置来自远程频道源", {
        version: fromRemote.version,
        channelCount: fromRemote.defaultChannels.length,
      });
      return fromRemote;
    }
    loggers.search.warn("频道配置未加载：本地与远程频道源均不可用");
    return null;
  }

  /**
   * 远程频道配置兜底层：从 remoteUrl 拉取频道配置。
   * 响应格式与 /api/channels 一致：{ code: 0, data: { version, channels } }。
   * 失败静默（不影响主链路），8s 超时。
   */
  private async loadFromRemote(): Promise<ChannelConfig | null> {
    const url = this.options.remoteUrl;
    if (!url) return null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const resp = await fetch(url, {
          headers: this.options.remoteKey
            ? { authorization: `Bearer ${this.options.remoteKey}` }
            : undefined,
          signal: controller.signal,
        });
        if (!resp.ok) return null;
        const body: any = await resp.json();
        const channels = Array.isArray(body?.data?.channels)
          ? body.data.channels.filter((x: unknown) => typeof x === "string")
          : [];
        if (channels.length === 0) return null;
        return {
          version: Number(body?.data?.version) || 0,
          priorityChannels: [],
          defaultChannels: channels,
        };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      loggers.search.warn("远程频道源拉取失败（走空配置）", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private async loadFromTurso(): Promise<ChannelConfig | null> {
    const { tursoUrl, authToken, channelKey } = this.options;
    if (!tursoUrl || !channelKey) return null;
    const { createClient } = await import("@libsql/client");
    const client = createClient({ url: tursoUrl, authToken: authToken || undefined });
    try {
      const rows = (
        await client.execute(
          "SELECT version, payload FROM channel_config ORDER BY version DESC LIMIT 1"
        )
      ).rows;
      const row = rows[0];
      if (!row || typeof row.payload !== "string") return null;
      const plain = decryptChannelConfig(row.payload, channelKey);
      const parsed = JSON.parse(plain);
      const config = toChannelConfig(parsed);
      if (!config) return null;
      // version 以表列为准（payload 内若带 version 仅作后备，避免两份数据不一致）
      return { ...config, version: Number(row.version) || config.version };
    } catch (err) {
      loggers.search.warn("Turso 频道配置拉取失败（走兜底）", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      try {
        client.close();
      } catch {}
    }
  }

  private parseEnvJson(): ChannelConfig | null {
    if (!this.options.envJson) return null;
    try {
      return toChannelConfig(JSON.parse(this.options.envJson));
    } catch {
      return null;
    }
  }
}

// 全局单例（构造时从环境变量读取配置；测试请直接 new 注入 file: 库与密钥）
const globalChannelConfigService = new ChannelConfigService({
  tursoUrl: process.env.TURSO_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
  channelKey: process.env.CHANNEL_KEY,
  envJson: process.env.CHANNELS_JSON,
  remoteUrl: process.env.CHANNELS_REMOTE_URL,
  remoteKey: process.env.CHANNELS_API_KEY,
  channelsKeys: process.env.CHANNELS_KEYS,
});
export function getChannelConfigService(): ChannelConfigService {
  return globalChannelConfigService;
}
