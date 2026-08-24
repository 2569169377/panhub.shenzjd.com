import { defineEventHandler, getQuery, getRequestHeader, createError } from "h3";
import { getChannelConfigService } from "../core/services/channelConfigService";

/**
 * 频道配额下发接口（2026-08-24，二次迭代）
 *
 * 面向 fork 站/第三方（官方站前端已不依赖本接口，前端只传批次号）。
 * 给 fork 站提供"部分开源"能力：
 *   - 无 key：基础配额（CHANNELS_DEFAULT_GRANT，默认 10 个 default 频道）
 *   - 有 key（Authorization: Bearer 或 ?key=）：按 CHANNELS_KEYS 配置的配额，
 *     "all" 给全部 default 频道；priority 频道一律不下发（核心优势保留）
 *   - key 由官方决定给谁、给多少，可随时从环境变量增删
 *
 * 响应：{ code, data: { version, channels } } —— 只含频道名，无总数、无 priority。
 * 防护：Origin 白名单 + 全局限流（rateLimiter /api/channels 条目）。
 */
const DEFAULT_ALLOWED_ORIGINS = [
  "https://panhub.shenzjd.com",
  "https://www.shenzjd.com",
  "http://localhost:4000",
  "http://127.0.0.1:4000",
];

function isAllowedOrigin(event: any): boolean {
  const origin = getRequestHeader(event, "origin");
  // fork 站是服务端 fetch（无 Origin），放行（交给限流与 key 配额）
  if (!origin) return true;
  const allowRaw = process.env.CHANNELS_ALLOWED_ORIGINS;
  const allowed = allowRaw
    ? allowRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : DEFAULT_ALLOWED_ORIGINS;
  return allowed.some((o) => origin === o || origin.startsWith(`${o}/`));
}

export default defineEventHandler(async (event) => {
  if (!isAllowedOrigin(event)) {
    throw createError({ statusCode: 403, statusMessage: "origin not allowed" });
  }

  const service = getChannelConfigService();
  await service.ensureLoaded();

  // 读取 API Key：Authorization: Bearer <key> 或 ?key=<key>
  let apiKey: string | null = null;
  const auth = getRequestHeader(event, "authorization");
  if (auth && auth.startsWith("Bearer ")) {
    apiKey = auth.slice(7).trim() || null;
  }
  if (!apiKey) {
    const q = getQuery(event);
    apiKey = typeof q.key === "string" && q.key ? q.key : null;
  }

  const defaultGrant = Math.max(0, Math.floor(Number(process.env.CHANNELS_DEFAULT_GRANT) || 10));
  const grant = service.resolveChannelGrant(apiKey, defaultGrant);
  const { version, channels } = service.getGrantedChannels(grant);

  return {
    code: 0,
    message: "ok",
    data: { version, channels },
  };
});
