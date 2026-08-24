import type { H3Event } from "h3";
import { createError, getHeader, getRequestHeader } from "h3";
import { isUnlocked } from "./auth";
import { isBotUA } from "../../utils/botUA";
import { loggers } from "../core/utils/logger";
import { getClientIp } from "../middleware/rateLimiter";
import { isWxAuthEnforced, verifyWxAuthOnceCached } from "./wxAuthCheck";
import { getOrCreateBotDefenseService } from "../core/services/botDefense";

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
  const ip = getClientIp(event);
  loggers.search.warn(`拦截 bot UA 搜索请求`, {
    ip,
    ua: ua?.slice(0, 200),
    path: event.path,
    method: event.method,
  });
  // 累积到 IP 黑名单（异步、不阻塞 hot path 拒绝）；同一 IP 多次命中阈值后自动 24h 拉黑
  void getOrCreateBotDefenseService().recordRejection(ip, "bot_ua");
  throw createError({ statusCode: 403, statusMessage: "bot forbidden" });
}

/**
 * 微信关注公众号登录态校验（2026-08-22，开关控制）
 *
 * 思路：前端已强制"关注公众号 + 验证码"才能搜索，但脚本直调 API 可绕过
 * 前端弹窗。本层在服务端实时校验 wxauth cookie（wxauth-token/wxauth-openid），
 * 未认证请求直接 401，从根上挡住刷词脚本。
 *
 * 规则（2026-08-22 用户拍板）：
 * - 仅当 WX_AUTH_ENFORCE=1 时启用（默认关闭，不影响现状）
 * - 已带 Bearer / x-panhub-client-secret 凭证（小程序/API）→ 放行
 * - **实时校验、不缓存**：取消关注 = 退出登录，下次搜索立即 401
 * - wx-auth 服务故障 → 降级放行（不误伤真人），打 warn 日志
 */
export async function requireWxAuth(event: H3Event): Promise<void> {
  if (!isWxAuthEnforced()) return;
  // 已授权客户端（小程序/API）凭证放行
  const auth = getRequestHeader(event, "authorization");
  const clientSecret = getRequestHeader(event, "x-panhub-client-secret");
  if ((auth && auth.startsWith("Bearer ")) || clientSecret) return;

  const ok = await verifyWxAuthOnceCached(event);
  if (!ok) {
    const ip = getClientIp(event);
    loggers.search.warn(`拦截未关注公众号的搜索请求`, {
      ip,
      path: event.path,
      method: event.method,
    });
    // 累积到 IP 黑名单：未关注公众号却直调搜索 API 的脚本行为，等同攻击意图
    void getOrCreateBotDefenseService().recordRejection(ip, "bot_ua");
    throw createError({ statusCode: 401, statusMessage: "wx auth required" });
  }
}
