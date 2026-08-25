import type { H3Event } from "h3";
import { getCookie } from "h3";
import { loggers } from "../core/utils/logger";

/**
 * 微信关注公众号登录态校验（服务端）
 *
 * 前端 wx-auth-sdk 强制关注公众号 + 验证码后，在浏览器种两个 cookie：
 * - wxauth-token   （认证成功后签发的 token）
 * - wxauth-openid  （无 token 时的 openid 兜底）
 *
 * 本模块在服务端校验这两个 cookie 是否有效（实时调 wx-auth 服务的
 * /api/auth/check），用于拦截"未关注公众号"的脚本/爬虫直调搜索接口。
 *
 * 关键设计（2026-08-22 用户拍板）：
 * 1. 开关控制：仅当 WX_AUTH_ENFORCE=1 时启用（默认关闭，不影响现状）
 * 2. **实时校验、不缓存**：取消关注 = 退出登录，下次搜索立即 401，
 *    绝不把已失效的登录态当有效（用户明确要求）
 * 3. 请求内去重：同一个请求（event）内只校验一次（前端一次搜索会并发
 *    多个 /api/search 子请求，靠 event.context 标记避免重复打远程；
 *    这是请求内复用，不是跨请求缓存）
 * 4. 服务降级：wx-auth 服务不可达/超时 → 放行（宁可多放，不误伤真人），
 *    但打 warn 日志便于观察
 * 5. 无 cookie / 校验失败 → 返回 false（拒绝）
 */

const WX_AUTH_API_BASE = process.env.WX_AUTH_API_BASE || "https://wx-auth.shenzjd.com";
const WX_AUTH_CHECK_TIMEOUT_MS = 5000;

/** 开关：仅当显式设置 WX_AUTH_ENFORCE=1 时启用登录态拦截 */
export function isWxAuthEnforced(): boolean {
  return process.env.WX_AUTH_ENFORCE === "1";
}

/** 从请求中提取 wxauth 凭证（token 优先，openid 兜底） */
export function getWxAuthCredential(event: H3Event): { token?: string; openid?: string } {
  const token = getCookie(event, "wxauth-token");
  const openid = getCookie(event, "wxauth-openid");
  if (token) return { token };
  if (openid) return { openid };
  return {};
}

/** 调 wx-auth /api/auth/check，返回是否已认证。远程故障时降级放行（返回 true）并打日志。 */
export async function verifyWxAuthCredential(event: H3Event): Promise<boolean> {
  const cred = getWxAuthCredential(event);
  const query = cred.token ? `token=${encodeURIComponent(cred.token)}` : cred.openid ? `openid=${encodeURIComponent(cred.openid)}` : "";
  if (!query) {
    loggers.api.debug?.("wx-auth 无凭证 cookie");
    return false;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WX_AUTH_CHECK_TIMEOUT_MS);
    const res = await fetch(`${WX_AUTH_API_BASE}/api/auth/check?${query}`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    clearTimeout(timer);
    if (!res.ok) {
      loggers.api.warn?.("wx-auth check 非 2xx，降级放行", { status: res.status });
      return true;
    }
    const data = (await res.json()) as {
      authenticated?: boolean;
      user?: { openid?: string };
    };
    if (data.authenticated === true) {
      // 2026-08-25：check 响应带回 openid，存请求上下文供搜索日志
      // 关联"哪个 openid 搜了什么"（见 recordSearchTerm）
      if (data.user?.openid) {
        (event.context as Record<string, any>).__wxAuthOpenid = data.user.openid;
      }
      return true;
    }
    return false;
  } catch (err) {
    // 网络错误/超时 → 降级放行，不误伤真人（但打日志便于观察）
    loggers.api.warn?.("wx-auth check 请求失败，降级放行", {
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

/** 请求内去重：同一次请求只校验一次 wx-auth（结果存 event.context） */
export async function verifyWxAuthOnce(event: H3Event): Promise<boolean> {
  const ctx = (event.context as Record<string, any>) || {};
  if (typeof ctx.__wxAuthVerified === "boolean") return ctx.__wxAuthVerified;
  const ok = await verifyWxAuthCredential(event);
  ctx.__wxAuthVerified = ok;
  return ok;
}

/**
 * 跨请求短 TTL 缓存（2026-08-24 新增，修复 WX_AUTH_ENFORCE=1 时"认证后反复弹验证码"）
 *
 * 背景：一次搜索前端并发 35+ 子请求（countOnly + 各 batch + 各插件），每个子请求
 * 都走 verifyWxAuthOnce → 实时调 wx-auth /api/auth/check。而 wx-auth 的 check 按 IP
 * 限流 query 类型 30 次/分钟，一次搜索 40+ 次调用直接打爆 → rate_limited →
 * authenticated:false → 后端 401 → 前端 forceVerify 反复弹验证码弹窗。
 *
 * 修复：同一 credential（token/openid）在 WX_AUTH_CACHE_TTL_MS 内只调一次远程，
 * 其余子请求命中缓存（含 false 结果，10s 内同一 token 反复失败也按 401 处理，
 * 前端 forceVerify 会重发新 token，天然绕开旧缓存）。
 *
 * 与"实时校验不缓存"（用户拍板：取消关注=退出登录）的取舍：TTL 仅 10s，
 * 取消关注后最长 10s 内仍可搜，换取不打爆 wx-auth 限流。可接受。
 */
const WX_AUTH_CACHE_TTL_MS = 10_000;
const wxAuthCache = new Map<
  string,
  { ok: boolean; openid?: string; expiresAt: number }
>();

/** 测试用：清空跨请求缓存 */
export function resetWxAuthCache(): void {
  wxAuthCache.clear();
}

export async function verifyWxAuthOnceCached(event: H3Event): Promise<boolean> {
  const ctx = (event.context as Record<string, any>) || {};
  if (typeof ctx.__wxAuthVerified === "boolean") return ctx.__wxAuthVerified;

  const cred = getWxAuthCredential(event);
  const cacheKey = cred.token
    ? `token:${cred.token}`
    : cred.openid
    ? `openid:${cred.openid}`
    : "";
  const now = Date.now();

  if (cacheKey) {
    const hit = wxAuthCache.get(cacheKey);
    if (hit && hit.expiresAt > now) {
      ctx.__wxAuthVerified = hit.ok;
      // 2026-08-25：缓存命中也要恢复 openid（搜索日志关联用）
      if (hit.openid) ctx.__wxAuthOpenid = hit.openid;
      return hit.ok;
    }
  }

  const ok = await verifyWxAuthCredential(event);
  ctx.__wxAuthVerified = ok;
  if (cacheKey) {
    wxAuthCache.set(cacheKey, {
      ok,
      openid: ctx.__wxAuthOpenid,
      expiresAt: now + WX_AUTH_CACHE_TTL_MS,
    });
    // 防 Map 无限膨胀：超 10k 时清掉过期条目
    if (wxAuthCache.size > 10_000) {
      for (const [k, v] of wxAuthCache) {
        if (v.expiresAt <= now) wxAuthCache.delete(k);
      }
    }
  }
  return ok;
}
