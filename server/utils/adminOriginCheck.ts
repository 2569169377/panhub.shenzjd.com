import type { H3Event } from "h3";
import { createError, getRequestHeader } from "h3";

/**
 * 管理接口同源校验（2026-08-26 P1 补丁）
 *
 * 背景：管理接口仅凭 wxauth-token cookie 鉴权——任意第三方网站都能让
 * 已登录管理员浏览器"静默发起"拉黑/移除请求（CSRF）。本模块按来源
 * 过滤：跨源的管理接口调用一律 403（读/写策略分离，见下）。
 *
 * 策略（原则：误伤管理员的代价远高于放行恶意请求的代价）：
 * - 读接口 GET/HEAD：Origin/Referer 至少一个匹配白名单即放行。
 *   浏览器正常导航、站内跳转都带来源；读接口风险低，宁宽勿误伤。
 * - 写接口 POST/DELETE：强制校验。一旦同时存在 Origin 与 Referer，
 *   两者必须都匹配（防"前端禁 Referer + 跨站 POST"的绕过组合）；
 *   **无任何来源信息 → 拒绝**（不设无来源后门）
 * - 白名单 ADMIN_ORIGIN_ALLOWLIST（逗号分隔，精确 host 匹配）：
 *   覆盖 CN 域名 CNAME 回源（带 host 域名）、本地多端调试
 * - 旁路 x-admin-heartbeat=1：Docker Restart 存活探活（内部地址，
 *   无 Cookie 无 CSRF 面，直接放行）
 *
 * 与既有鉴权（wx-auth isAdminUser）叠加：来源校验不通过直接 403，
 * 不进入管理员判定（fail-fast）。读接口校验默认开启，
 * ADMIN_FORCE_READ_ORIGIN=0 可关闭。
 */

/** 生产主站域名（host，不含协议，默认白名单） */
const DEFAULT_HOST = "panhub.shenzjd.com";

/** 来源规范化：去 scheme/路径/端口，仅留 host（小写） */
function extractHost(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (!v) return null;
  const m = /^(?:https?:\/\/)?([^/?#]+)/i.exec(v);
  if (!m) return null;
  return m[1].replace(/:\d+$/, "").toLowerCase();
}

/** 白名单集合（默认主站 + 环境变量扩展） */
function isAllowedHost(host: string): boolean {
  const allow = new Set(
    [
      DEFAULT_HOST,
      ...(process.env.ADMIN_ORIGIN_ALLOWLIST || "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ],
  );
  return allow.has(host.toLowerCase());
}

/** 内部探活旁路：Docker Restart 兜底源（无 Cookie 无 CSRF 面） */
export function isInternalHeartbeat(event: H3Event): boolean {
  return getRequestHeader(event, "x-admin-heartbeat") === "1";
}

/** 读策略：任一来源匹配即放行 */
function readOriginAllowed(event: H3Event): boolean {
  const origin = getRequestHeader(event, "origin");
  const referer = getRequestHeader(event, "referer");
  const oh = origin && extractHost(origin);
  const rh = referer && extractHost(referer);
  if (oh && isAllowedHost(oh)) return true;
  if (rh && isAllowedHost(rh)) return true;
  return false;
}

/** 写策略：存在的来源必须全部匹配；无来源 false */
function writeOriginAllowed(event: H3Event): boolean {
  const origin = getRequestHeader(event, "origin");
  const referer = getRequestHeader(event, "referer");
  const oh = origin && extractHost(origin);
  const rh = referer && extractHost(referer);
  const hosts = [oh, rh].filter((h): h is string => !!h);
  if (hosts.length === 0) return false;
  return hosts.every((h) => isAllowedHost(h));
}

/**
 * 管理接口同源校验入口。校验通过返回 true；
 * 不通过抛 403 createError（fail-fast，不进入 admin 判定）。
 */
export function requireAdminOrigin(event: H3Event): boolean {
  // 内部探活旁路
  if (isInternalHeartbeat(event)) return true;

  const method = (event.method || "GET").toUpperCase();

  if (method === "GET" || method === "HEAD") {
    if (process.env.ADMIN_FORCE_READ_ORIGIN !== "0" && !readOriginAllowed(event)) {
      throw createError({ statusCode: 403, statusMessage: "forbidden" });
    }
    return true;
  }

  if (!writeOriginAllowed(event)) {
    throw createError({ statusCode: 403, statusMessage: "forbidden" });
  }
  return true;
}