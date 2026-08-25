import { defineEventHandler, getQuery, createError } from "h3";
import { getOrCreateBotDefenseService } from "../core/services/botDefense";
import { isAdminUser, getWxAuthCredential } from "../utils/wxAuthCheck";
import { requireAdminOrigin } from "../utils/adminOriginCheck";

/**
 * IP 黑名单管理查询 API（2026-08-25：管理页"IP 黑名单" tab 数据源）
 *
 * 鉴权：与 /api/search-log 一致 —— wx-auth isAdminUser（管理员标记）。
 * 区分（2026-08-25）：无 wxauth-token cookie → 401（未登录，请先到首页
 * 完成关注公众号）；是登录态但非管理员 → 403。
 * 同源校验（2026-08-26 P1 补丁）：读接口，来源校验同 search-log。
 * 返回 rejected_ips 全部条目（封禁中 + 惯犯档案 + 未达阈值短记录）：
 *   ip / reason / hitCount / blockCount（分级档位） / firstAt / lastAt / expiresAt
 * 调用方结合 now 计算"封禁中 / 剩余时长 / 已解封"。
 */

export default defineEventHandler(async (event) => {
  // ---- 来源校验（P1，先于鉴权 fail-fast）----
  requireAdminOrigin(event);
  if (!getWxAuthCredential(event).token) {
    throw createError({ statusCode: 401, statusMessage: "wx auth required" });
  }
  if (!(await isAdminUser(event))) {
    throw createError({ statusCode: 403, statusMessage: "forbidden" });
  }

  const q = getQuery(event);
  const limit = Math.min(Math.max(1, parseInt(String(q.limit || "100"), 10) || 100), 500);

  const service = getOrCreateBotDefenseService();
  const now = Date.now();
  const items = await service.listEntries(limit);

  const enriched = items.map((it) => ({
    ...it,
    blocked: it.expiresAt > now, // 是否仍在封禁期
    remainingMs: it.expiresAt > now ? it.expiresAt - now : 0, // 剩余封禁时长
  }));

  return {
    code: 0,
    message: "success",
    data: { now, items: enriched, total: enriched.length },
  };
});
