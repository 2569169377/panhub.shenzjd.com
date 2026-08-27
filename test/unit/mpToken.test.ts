/**
 * mpToken（MpTokenStore）单元测试
 *
 * 验证 token 签发/校验/吊销逻辑：
 * - signToken 签发后 verifyToken 有效
 * - revokeToken 吊销后 verifyToken 无效
 * - revokeByOpenid 吊销某 openid 所有 token
 * - 过期 token 无效
 * - 不存在的 token 无效
 *
 * 使用内存 libsql（file::memory:）避免依赖外部 Turso 实例。
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MpTokenStore, resetMpTokenStore } from "../../server/utils/mpToken";

describe("MpTokenStore", () => {
  let store: MpTokenStore;

  beforeEach(() => {
    // 用内存 SQLite 测试，不走单例（避免环境变量干扰）
    store = new MpTokenStore("file::memory:", "");
    resetMpTokenStore();
  });

  it("signToken 签发后 verifyToken 有效，返回 openid", async () => {
    const openid = "mp-openid-abc";
    const token = await store.signToken(openid);
    expect(token).toBeTruthy();
    expect(typeof token).toBe("string");
    expect(token.length).toBe(64); // 32 bytes hex

    const result = await store.verifyToken(token);
    expect(result.valid).toBe(true);
    expect(result.openid).toBe(openid);
  });

  it("不存在的 token → 无效", async () => {
    const result = await store.verifyToken("nonexistent-token");
    expect(result.valid).toBe(false);
    expect(result.openid).toBeUndefined();
  });

  it("revokeToken 吊销后 → 无效", async () => {
    const token = await store.signToken("mp-openid-1");
    expect((await store.verifyToken(token)).valid).toBe(true);

    const revoked = await store.revokeToken(token);
    expect(revoked).toBe(true);

    const result = await store.verifyToken(token);
    expect(result.valid).toBe(false);
  });

  it("revokeByOpenid 吊销该 openid 所有 token，其他 openid 不受影响", async () => {
    const token1 = await store.signToken("openid-A");
    const token2 = await store.signToken("openid-A");
    const token3 = await store.signToken("openid-B");

    // 吊销 A 的所有 token
    const count = await store.revokeByOpenid("openid-A");
    expect(count).toBe(2);

    // A 的 token 都失效
    expect((await store.verifyToken(token1)).valid).toBe(false);
    expect((await store.verifyToken(token2)).valid).toBe(false);
    // B 的 token 仍有效
    expect((await store.verifyToken(token3)).valid).toBe(true);
  });

  it("过期 token → 无效", async () => {
    const now = Date.now();
    // 签发时用"7 天前"的时间戳，使 expires_at = now（已过期）
    const pastNow = now - 7 * 24 * 60 * 60_000 - 1;
    const token = await store.signToken("mp-openid-expired", pastNow);

    // 用当前时间校验 → 已过期
    const result = await store.verifyToken(token, now);
    expect(result.valid).toBe(false);
  });

  it("pruneExpired 清理过期 token", async () => {
    const now = Date.now();
    // 签发一个"8 天前"的 token（已过期）
    const expiredToken = await store.signToken(
      "mp-old",
      now - 8 * 24 * 60 * 60_000
    );
    // 签发一个正常的 token（未过期）
    const validToken = await store.signToken("mp-new", now);

    const deleted = await store.pruneExpired(now);
    expect(deleted).toBe(1);

    // 过期的被清理
    expect((await store.verifyToken(expiredToken, now)).valid).toBe(false);
    // 未过期的仍有效
    expect((await store.verifyToken(validToken, now)).valid).toBe(true);
  });

  it("同一 openid 可签发多个 token（多端登录）", async () => {
    const openid = "mp-multi-device";
    const t1 = await store.signToken(openid);
    const t2 = await store.signToken(openid);

    expect(t1).not.toBe(t2);
    expect((await store.verifyToken(t1)).valid).toBe(true);
    expect((await store.verifyToken(t2)).valid).toBe(true);
    expect((await store.verifyToken(t1)).openid).toBe(openid);
    expect((await store.verifyToken(t2)).openid).toBe(openid);
  });

  it("revokeToken 吊销已不存在的 token → 返回 false", async () => {
    const result = await store.revokeToken("ghost-token");
    expect(result).toBe(false);
  });

  it("revokeToken 吊销已吊销的 token → 返回 false（幂等）", async () => {
    const token = await store.signToken("mp-once");
    expect(await store.revokeToken(token)).toBe(true);
    // 再次吊销同一个 → 已是 revoked=1，不影响行，返回 false
    expect(await store.revokeToken(token)).toBe(false);
  });
});
