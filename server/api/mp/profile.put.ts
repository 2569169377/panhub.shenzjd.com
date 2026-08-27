import { defineEventHandler, readBody, createError } from "h3";
import { getMpUserStore, getOpenidFromBearer } from "../../utils/mpUserStore";

/**
 * 更新小程序用户资料（2026-08-28 新增）
 *
 * PUT /api/mp/profile
 * Header: Authorization: Bearer <mp token>
 * Body: { nickname?: string, avatar?: string }
 *   - nickname ≤30 字（超出截断）；avatar 为 data URL（base64，≤256KB）
 *   - 只更新传入的字段
 * 返回 { code: 0, data: { nickname, avatar, updatedAt } }
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

  const body = await readBody<{ nickname?: string; avatar?: string }>(event);
  const patch: { nickname?: string; avatar?: string } = {};

  if (typeof body?.nickname === "string") patch.nickname = body.nickname;
  if (typeof body?.avatar === "string") {
    // data URL 基本校验（image/jpeg|png|webp;base64,）
    if (!/^data:image\/(jpeg|png|webp);base64,/.test(body.avatar)) {
      throw createError({ statusCode: 400, statusMessage: "invalid avatar" });
    }
    patch.avatar = body.avatar;
  }

  if (Object.keys(patch).length === 0) {
    throw createError({ statusCode: 400, statusMessage: "empty update" });
  }

  try {
    const profile = await store.upsert(openid, patch);
    return {
      code: 0,
      message: "ok",
      data: {
        nickname: profile.nickname,
        avatar: profile.avatar,
        updatedAt: profile.updatedAt,
      },
    };
  } catch (err) {
    if (err instanceof Error && err.message === "avatar too large") {
      throw createError({ statusCode: 413, statusMessage: "avatar too large" });
    }
    throw err;
  }
});
