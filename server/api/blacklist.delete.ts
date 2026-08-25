import { defineEventHandler, getQuery, createError } from "h3";
import { getOrCreateBotDefenseService } from "../core/services/botDefense";
import { isAdminUser, getWxAuthCredential } from "../utils/wxAuthCheck";

/**
 * IP 手动移除黑名单 API（2026-08-25 管理页"移除"按钮）
 *
 * 鉴权：与 /api/blacklist GET 一致 —— wx-auth isAdminUser。
 * query: ?ip=xxx
 * 行为：删除 Turso 整行（含惯犯档案）并清理缓存，下一次 isBlocked 立即放行。
 */
export default defineEventHandler(async (event) => {
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