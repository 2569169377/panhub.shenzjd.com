import { defineEventHandler, readBody, createError } from "h3";
import { getOrCreateBotDefenseService } from "../core/services/botDefense";
import { isAdminUser, getWxAuthCredential } from "../utils/wxAuthCheck";
import { requireAdminOrigin } from "../utils/adminOriginCheck";

/**
 * IP 手动拉黑 API（2026-08-25 管理页"加入黑名单"按钮）
 *
 * 鉴权：与 /api/blacklist GET 一致 —— wx-auth isAdminUser。
 * 同源校验（2026-08-26 P1 补丁）：写接口强制校验——Origin/Referer
 * 必须至少一个且全部匹配白名单；无来源/跨源直接 403（详见 adminOriginCheck）。
 * body: { ip: string, reason?: string }
 *   - reason 缺省 manual（管理页预置：manual=手动拉黑）
 * 行为：block_count +1 → 30 天封禁，同时刷新 service 缓存使拦截立即生效。
 * 返回新 blockCount，便于调用方回显。
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

  const body = await readBody<{ ip?: string; reason?: string }>(event);
  const ip = (body?.ip ?? "").trim();
  if (!ip) {
    throw createError({ statusCode: 400, statusMessage: "ip required" });
  }
  const reason = (body?.reason ?? "manual").trim() || "manual";

  const service = getOrCreateBotDefenseService();
  const blockCount = await service.manuallyBlock(ip, reason);

  return {
    code: 0,
    message: "success",
    data: { ip, reason, blockCount },
  };
});