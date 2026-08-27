import { defineEventHandler, readBody, createError } from "h3";
import { getMpTokenStore } from "../utils/mpToken";
import { loggers } from "../core/utils/logger";

/**
 * 小程序登录接口（2026-08-28 新增）
 *
 * 流程：
 * 1. 小程序调 wx.login() 拿 code
 * 2. 调本接口传 code
 * 3. 后端用小程序 appid + secret 调微信 code2session 换 openid
 * 4. 签发 token（绑定 openid）存入 Turso，返回给小程序
 * 5. 小程序后续请求带 Authorization: Bearer <token>
 *
 * 安全设计：
 * - 身份验证靠小程序 appid + secret：只有你的小程序能换出有效 openid
 *   （别人的小程序用他们的 appid，换不到你后端认可的 openid）
 * - token 可吊销：泄露时后端 revokeToken 即时生效，无需小程序发版
 * - Turso 不可用 → fail-closed 拒绝（宁可不可用，不裸奔）
 * - fail-closed：code2session 远程故障 → 拒绝，不降级放行
 *
 * 环境变量：
 * - MP_APPID：小程序 appid
 * - MP_SECRET：小程序 secret
 */

const CODE2SESSION_URL = "https://api.weixin.qq.com/sns/jscode2session";
const CODE2SESSION_TIMEOUT_MS = 5000;

export default defineEventHandler(async (event) => {
  const body = await readBody<{ code?: string }>(event);
  const code = (body?.code || "").trim();

  if (!code) {
    throw createError({ statusCode: 400, statusMessage: "code is required" });
  }

  const appid = process.env.MP_APPID;
  const secret = process.env.MP_SECRET;

  if (!appid || !secret) {
    loggers.search.warn("小程序登录未配置 MP_APPID/MP_SECRET");
    throw createError({
      statusCode: 500,
      statusMessage: "server not configured",
    });
  }

  // 1. 调微信 code2session 换 openid
  let openid: string;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CODE2SESSION_TIMEOUT_MS);
    const url = `${CODE2SESSION_URL}?appid=${encodeURIComponent(
      appid
    )}&secret=${encodeURIComponent(secret)}&js_code=${encodeURIComponent(
      code
    )}&grant_type=authorization_code`;

    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    clearTimeout(timer);

    if (!res.ok) {
      loggers.search.warn("code2session 非 2xx，fail-closed 拒绝", {
        status: res.status,
      });
      throw createError({
        statusCode: 401,
        statusMessage: "wx login failed",
      });
    }

    const data = (await res.json()) as {
      openid?: string;
      session_key?: string;
      errcode?: number;
      errmsg?: string;
    };

    // 微信错误码（如 code 失效、appid 不匹配等）
    if (data.errcode && data.errcode !== 0) {
      loggers.search.warn("code2session 返回错误", {
        errcode: data.errcode,
        errmsg: data.errmsg,
      });
      throw createError({
        statusCode: 401,
        statusMessage: "wx login failed",
      });
    }

    if (!data.openid) {
      loggers.search.warn("code2session 未返回 openid");
      throw createError({
        statusCode: 401,
        statusMessage: "wx login failed",
      });
    }

    openid = data.openid;
  } catch (err) {
    // fetch 网络错误/超时 → fail-closed 拒绝
    if (err && typeof err === "object" && "__isH3Error" in err) throw err;
    loggers.search.warn("code2session 请求失败，fail-closed 拒绝", {
      error: err instanceof Error ? err.message : String(err),
    });
    throw createError({
      statusCode: 401,
      statusMessage: "wx login failed",
    });
  }

  // 2. 签发 token
  const store = getMpTokenStore();
  if (!store) {
    loggers.search.warn("MpTokenStore 不可用，登录失败");
    throw createError({
      statusCode: 500,
      statusMessage: "token store unavailable",
    });
  }

  const token = await store.signToken(openid);

  // 3. 返回 token（openid 也可返回，小程序端可选用于关联展示）
  return {
    code: 0,
    message: "ok",
    data: {
      token,
      openid,
    },
  };
});
