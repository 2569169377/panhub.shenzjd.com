import { defineEventHandler, getQuery, createError } from "h3";
import { getSearchLogStore } from "../core/services/tursoSearchLogStore";
import { verifyWxAuthOnceCached } from "../utils/wxAuthCheck";

/**
 * 搜索明细管理查询 API（2026-08-25 用户拍板：排查"哪个 openid 搜了什么"）
 *
 * 鉴权（用户拍板：**不用密码、不用 key，直接用微信 openid 校验权限**）：
 * - 白名单：SEARCH_LOG_ADMIN_OPENIDS 环境变量（逗号分隔的 openid 列表）
 * - 请求带 wxauth cookie → verifyWxAuthOnceCached 校验登录态并解出 openid
 *   （openid 由 check 响应带回，10s 缓存内复用；cookie 长期有效可一直用）
 * - openid 在白名单 → 放行；未登录 401；不在白名单 403
 * - 未配置白名单 → 403（接口不可用，避免裸奔泄露）
 *
 * 用法：
 *   GET /api/search-log?openid=<openid>&limit=50&days=7
 *     → 某 openid 最近搜了什么（term/ip/createdAt，时间倒序）
 *   GET /api/search-log?term=<词>&limit=50&days=7
 *     → 搜过该词的所有 openid/ip（时间倒序）
 *
 * 数据为个人搜索历史，严禁暴露给前端页面（仅管理端排查用）。
 */

const ADMIN_OPENIDS = new Set(
  (process.env.SEARCH_LOG_ADMIN_OPENIDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

export default defineEventHandler(async (event) => {
  // ---- 鉴权：微信 openid 白名单（2026-08-25 用户拍板，无密码/key）----
  if (ADMIN_OPENIDS.size === 0) {
    throw createError({ statusCode: 403, statusMessage: "search log admin not configured" });
  }
  const authed = await verifyWxAuthOnceCached(event);
  if (!authed) {
    throw createError({ statusCode: 401, statusMessage: "wx auth required" });
  }
  const openid = (event.context as Record<string, any>)?.__wxAuthOpenid as string | undefined;
  if (!openid || !ADMIN_OPENIDS.has(openid)) {
    throw createError({ statusCode: 403, statusMessage: "forbidden" });
  }

  const store = getSearchLogStore();
  if (!store) {
    throw createError({ statusCode: 503, statusMessage: "search log store unavailable" });
  }

  const q = getQuery(event);
  const limit = Math.min(Math.max(1, parseInt(String(q.limit || "50"), 10) || 50), 200);
  const daysRaw = parseInt(String(q.days || ""), 10);
  const since = Number.isFinite(daysRaw) && daysRaw >= 1 ? Date.now() - daysRaw * 86400000 : undefined;

  const targetOpenid = String(q.openid || "").trim().slice(0, 128);
  const term = String(q.term || "").trim().slice(0, 200);

  if (targetOpenid && term) {
    throw createError({ statusCode: 400, statusMessage: "openid 与 term 只能二选一" });
  }
  if (!targetOpenid && !term) {
    throw createError({ statusCode: 400, statusMessage: "需提供 openid 或 term 参数" });
  }

  if (targetOpenid) {
    const items = await store.searchByOpenid(targetOpenid, limit, since);
    return {
      code: 0,
      message: "success",
      data: { mode: "openid", openid: targetOpenid, items, total: items.length },
    };
  }

  const items = await store.searchByTerm(term, limit, since);
  return {
    code: 0,
    message: "success",
    data: { mode: "term", term, items, total: items.length },
  };
});
