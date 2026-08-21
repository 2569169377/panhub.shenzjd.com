import type { H3Event } from "h3";
import { createError, getHeader, getRequestHeader } from "h3";
import { isUnlocked } from "./auth";
import { isBotUA } from "../../utils/botUA";
import { loggers } from "../core/utils/logger";

export function requireSearchAuth(event: H3Event): void {
  const config = useRuntimeConfig();
  const password = (config.searchPassword as string) || "";
  if (!password.trim()) return;
  if (!isUnlocked(event, password)) {
    throw createError({ statusCode: 401, statusMessage: "search locked" });
  }
}

/**
 * 搜索入口的爬虫/脚本 UA 拦截（2026-08-22）
 *
 * 背景：仅过滤"搜索词记录"不足以防刷——攻击者照样触发完整搜索
 * （一次搜索 = 并发请求全部 TG 频道 + 插件源，资源放大数十倍），
 * 刷词持续占用服务器资源。因此在入口直接 403 拒绝 bot UA 请求，
 * 连搜索都不执行，从根上杜绝资源消耗。
 *
 * 放行规则：
 * - 正常浏览器 UA → 放行（真人搜索不受影响）
 * - bot/脚本 UA 且无凭证 → 403（curl/python-requests 等刷词工具）
 * - bot/脚本 UA 但带 Authorization: Bearer 或 x-panhub-client-secret
 *   → 放行（小程序/已授权 API 客户端，UA 常被识别为脚本但属真实渠道）
 *
 * 与 requireSearchAuth 独立：即使未配置 SEARCH_PASSWORD（密码门关闭），
 * bot UA 也会被此层拦截；真人浏览器仍可正常搜索。
 *
 * 2026-08-22 收紧：命中拦截时打 warn 日志（含 UA 与路径），
 * 便于观察是否误伤真实用户；发现误伤可随时收紧/回退。
 */
export function requireHumanOrCredential(event: H3Event): void {
  const ua = getHeader(event, "user-agent");
  if (!isBotUA(ua)) return;
  // 已授权客户端（小程序/API）凭据放行，避免误伤真实渠道
  const auth = getRequestHeader(event, "authorization");
  const clientSecret = getRequestHeader(event, "x-panhub-client-secret");
  if ((auth && auth.startsWith("Bearer ")) || clientSecret) return;
  loggers.search.warn(`拦截 bot UA 搜索请求`, {
    ua: ua?.slice(0, 200),
    path: event.path,
    method: event.method,
  });
  throw createError({ statusCode: 403, statusMessage: "bot forbidden" });
}
