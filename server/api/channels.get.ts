import { defineEventHandler, getRequestHeader, createError } from "h3";
import { getChannelConfigService } from "../core/services/channelConfigService";

/**
 * 频道配置下发接口（2026-08-24）
 *
 * 前端（useSettings SSR useFetch）通过本接口获取默认 TG 频道，
 * 频道清单不再编译进前端 bundle / 仓库（clone 即得的明文已移除）。
 *
 * 防护（对"仅官方站自用"阶段足够）：
 *   - Origin 白名单：仅放行官方域名与本地 dev；无 Origin 的 SSR 内部请求放行
 *   - 全局限流：server/middleware/rateLimiter.ts 已加 /api/channels 限额
 *   - 频道名本身不含资源链接；抓取/解析逻辑仍在服务器，泄露面有限
 *
 * 响应：{ version, priorityChannels, defaultChannels }
 */
const DEFAULT_ALLOWED_ORIGINS = [
  "https://panhub.shenzjd.com",
  "https://www.shenzjd.com",
  "http://localhost:4000",
  "http://127.0.0.1:4000",
];

function isAllowedOrigin(event: any): boolean {
  const origin = getRequestHeader(event, "origin");
  // SSR 内部请求 / 非浏览器客户端无 Origin，放行（交给限流）
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
  const snap = service.getSnapshot();
  return {
    version: snap.version,
    priorityChannels: snap.priorityChannels,
    defaultChannels: snap.defaultChannels,
  };
});
