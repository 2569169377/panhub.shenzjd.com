import { defineEventHandler, getQuery, createError } from "h3";
import { getOrCreateBotDefenseService } from "../core/services/botDefense";
import { isAdminUser, getWxAuthCredential } from "../utils/wxAuthCheck";
import { requireAdminOrigin } from "../utils/adminOriginCheck";

/**
 * IP 手动移除黑名单 API（2026-08-25 管理页"移除"按钮）
 *
 * 鉴权：与 /api/blacklist GET 一致 —— wx-auth isAdminUser。
 * 同源校验（2026-08-26 P1 补丁）：写接口强制校验（同 POST）。
 * query: ?ip=xxx
 * 行为：删除 Turso 整行（含惯犯档案）并清理缓存，下一次 isBlocked 立即放行。
 */
export default defineEventHandler(async (event) => {
  // ---- 来源校验（写操作，强制）----
  requireAdminOrigin(event);
  if (!getWxAuthCredential(event).token) {
    throw createError({ statusCode: 401, statusMessage: "wx auth required" });
  }
  if (!(await isAdminUser(event))) {
    throw createError({ statusCode: 403, statusMessage: "forbidden" });
  }

  const q = getQuery(event);
  const ip = String(q.ip ?? "").trim();
  if (!ip) {
    throw createError({ statusCode: 400, statusMessage: "ip required" });
  }

  const service = getOrCreateBotDefenseService();
  const removed = await service.removeBlock(ip);

  return {
    code: 0,
    message: removed ? "success" : "not found",
    data: { ip, removed },
  };
});