import { defineEventHandler, createError } from "h3";
import { getMpUserStore, getOpenidFromBearer } from "../../utils/mpUserStore";

/**
 * 获取小程序用户资料（2026-08-28 新增，同日改为 wx-auth 认证）
 *
 * GET /api/mp/profile
 * Header: Authorization: Bearer <wx-auth token>（wx-auth /api/auth/mp-login 签发）
 * 返回 { code: 0, data: { nickname, avatar, updatedAt } }
 * 未设置过资料时 data 里 nickname/avatar 为空串（前端用默认头像/占位文案）。
 */
export default defineEventHandler(async (event) => {
  const openid = await getOpenidFromBearer(event);
  if (!openid) {
    throw createError({ statusCode: 401, statusMessage: "invalid token" });
  }

  const store = getMpUserStore();
  if (!store) {
    throw createError({ statusCode: 500, statusMessage: "store unavailable" });
  }

  const profile = await store.get(openid);
  return {
    code: 0,
    message: "ok",
    data: {
      nickname: profile?.nickname ?? "",
      avatar: profile?.avatar ?? "",
      updatedAt: profile?.updatedAt ?? 0,
    },
  };
});
