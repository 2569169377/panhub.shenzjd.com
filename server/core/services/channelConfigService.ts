import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { loggers } from "../utils/logger";

/**
 * 频道配置服务（2026-08-24 上线）
 *
 * 背景：频道清单（70+ TG 频道 ID）是本项目核心资产，此前明文存于
 * config/channels.json 并编译进前端 bundle / 后端 runtimeConfig，
 * clone 仓库即可白嫖。现改为：
 *   - 真实清单加密（AES-256-GCM）存入 Turso channel_config 表；
 *   - 本服务启动/定期从 Turso 拉取最新版本并解密缓存；
 *   - 搜索服务（SearchServiceOptions）与 /api/channels 均从本服务读快照。
 *
 * 配置（环境变量）：
 *   TURSO_URL / TURSO_AUTH_TOKEN   Turso 连接（与热搜同库）
 *   CHANNEL_KEY                    64 位 hex（32 字节），加密/解密密钥，勿入库
 *   CHANNELS_JSON                  （可选兜底）明文 JSON，本地 dev / 无 Turso 时使用
 *
 * 加密说明：AES-256-GCM（认证加密，防篡改）。Worker 端经 nodejs_compat
 * 支持 node:crypto。密钥只存在于服务器环境变量，绝不进前端/仓库。
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
}

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
  private static readonly REFRESH_TTL = 5 * 60_000; // 5 分钟刷新一次

  private config: ChannelConfig | null = null;
  private loadPromise: Promise<ChannelConfig | null> | null = null;
  private lastLoadAt = 0;
  private options: ChannelConfigServiceOptions;

  constructor(options: ChannelConfigServiceOptions = {}) {
    this.options = options;
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
   * 确保频道配置已加载（幂等，带 TTL 与并发去重）。
   * 搜索 API 入口调用；Turso 不可用时静默降级到 env 兜底/空配置，
   * 不影响搜索主链路（TG 无频道时由隔离闸 B 降级为空结果）。
   */
  async ensureLoaded(): Promise<ChannelConfig> {
    if (
      this.config &&
      Date.now() - this.lastLoadAt < ChannelConfigService.REFRESH_TTL
    ) {
      return this.getSnapshot();
    }
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

  private async load(): Promise<ChannelConfig | null> {
    // 1. Turso 加密配置（生产主路径）
    const fromTurso = await this.loadFromTurso();
    if (fromTurso) {
      this.config = fromTurso;
      this.lastLoadAt = Date.now();
      loggers.search.info("频道配置已从 Turso 加载", { version: fromTurso.version });
      return fromTurso;
    }
    // 2. CHANNELS_JSON 兜底（本地 dev / 服务器 .env）
    const fromEnv = this.parseEnvJson();
    if (fromEnv) {
      this.config = fromEnv;
      this.lastLoadAt = Date.now();
      loggers.search.warn("频道配置来自 CHANNELS_JSON 兜底", { version: fromEnv.version });
      return fromEnv;
    }
    loggers.search.warn("频道配置未加载：Turso 不可用且无 CHANNELS_JSON 兜底");
    return null;
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
});

export function getChannelConfigService(): ChannelConfigService {
  return globalChannelConfigService;
}
