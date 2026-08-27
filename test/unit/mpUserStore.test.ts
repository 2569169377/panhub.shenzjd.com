/**
 * mpUserStore（MpUserStore）单元测试
 *
 * 验证用户资料 upsert/get 逻辑：
 * - 新用户 upsert（首次写入）
 * - 部分字段更新（只改昵称不动头像，反之亦然）
 * - 昵称 trim + 长度截断（>30 字）
 * - 头像超大（>256KB）→ 报错
 * - 不存在的用户 get → null
 *
 * 使用内存 libsql（file::memory:）避免依赖外部 Turso 实例。
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MpUserStore, resetMpUserStore } from "../../server/utils/mpUserStore";

describe("MpUserStore", () => {
  let store: MpUserStore;

  beforeEach(() => {
    store = new MpUserStore("file::memory:", "");
    resetMpUserStore();
  });

  it("不存在的用户 get → null", async () => {
    expect(await store.get("openid-none")).toBeNull();
  });

  it("首次 upsert 写入完整资料，get 读回一致", async () => {
    const avatar = "data:image/jpeg;base64,QUJD";
    const p = await store.upsert("openid-1", { nickname: "神族九帝", avatar });
    expect(p.nickname).toBe("神族九帝");
    expect(p.avatar).toBe(avatar);
    expect(p.updatedAt).toBeGreaterThan(0);

    const got = await store.get("openid-1");
    expect(got?.nickname).toBe("神族九帝");
    expect(got?.avatar).toBe(avatar);
  });

  it("只更新昵称时，头像保持不变（部分更新）", async () => {
    const avatar = "data:image/png;base64,WFhY";
    await store.upsert("openid-2", { nickname: "旧名", avatar });

    const p = await store.upsert("openid-2", { nickname: "新名" });
    expect(p.nickname).toBe("新名");
    expect(p.avatar).toBe(avatar); // 头像未被动
  });

  it("只更新头像时，昵称保持不变", async () => {
    await store.upsert("openid-3", { nickname: "稳定昵称" });
    const p = await store.upsert("openid-3", {
      avatar: "data:image/webp;base64,QUJD",
    });
    expect(p.nickname).toBe("稳定昵称");
    expect(p.avatar).toBe("data:image/webp;base64,QUJD");
  });

  it("昵称超长（>30 字）被截断，首尾空格被 trim", async () => {
    const long = "a".repeat(50);
    const p = await store.upsert("openid-4", { nickname: "  " + long + "  " });
    expect(p.nickname).toBe("a".repeat(30));
  });

  it("头像超过 256KB 上限 → upsert 抛错", async () => {
    const huge = "data:image/jpeg;base64," + "A".repeat(257 * 1024);
    await expect(store.upsert("openid-5", { avatar: huge })).rejects.toThrow(
      "avatar too large"
    );
  });

  it("upsert 传空字符串头像 → 覆盖为空", async () => {
    await store.upsert("openid-6", { avatar: "data:image/jpeg;base64,QQ==" });
    const p = await store.upsert("openid-6", { avatar: "" });
    expect(p.avatar).toBe("");
  });
});
