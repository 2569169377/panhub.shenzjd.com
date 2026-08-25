/**
 * TursoSearchLogStore 单元测试（2026-08-25 新增）
 *
 * 用 @libsql/client 的 file: 本地内存库（file::memory:）跑真实 SQL：
 * - logSearch 写入 openid/ip/term/created_at 明细
 * - 长期保留策略（用户拍板）：默认不自动清理；pruneExpired 仅在
 *   显式调用时删除超过保留期的数据（默认 90 天，未来撑不住时启用）
 * 不依赖线上 Turso（无网络、无凭据）。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TursoSearchLogStore } from "../../server/core/services/tursoSearchLogStore";

describe("TursoSearchLogStore", () => {
  let store: TursoSearchLogStore;

  beforeEach(async () => {
    store = new TursoSearchLogStore("file::memory:");
    await (store as any).waitForInit();
  });

  afterEach(() => {
    store.close();
  });

  it("logSearch 写入 openid/ip/term/created_at 明细", async () => {
    const now = 1_700_000_000_000;
    await store.logSearch({ openid: "openid-abc", ip: "1.2.3.4", term: "霸王别姬", now });

    const rows = (
      await (store as any).client.execute(
        "SELECT openid, ip, term, created_at FROM search_log"
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].openid).toBe("openid-abc");
    expect(rows[0].ip).toBe("1.2.3.4");
    expect(rows[0].term).toBe("霸王别姬");
    expect(rows[0].created_at).toBe(now);
  });

  it("未登录请求 openid 空串，仅记 ip+term", async () => {
    await store.logSearch({ ip: "9.9.9.9", term: "使徒行者" });
    const rows = (
      await (store as any).client.execute("SELECT openid FROM search_log")
    ).rows;
    expect(rows[0].openid).toBe("");
  });

  it("长期保留：90 天内数据不被 pruneExpired 默认清理", async () => {
    const now = 1_700_000_000_000;
    const day = 24 * 60 * 60_000;
    // 60 天前的数据（在默认 90 天保留期内）
    await store.logSearch({ openid: "o1", term: "老词", now: now - 60 * day });
    // 今天的数据
    await store.logSearch({ openid: "o2", term: "新词", now });

    const pruned = await store.pruneExpired(now); // 默认 90 天
    expect(pruned).toBe(0); // 60 天 < 90 天，不删

    const rows = (
      await (store as any).client.execute("SELECT COUNT(*) AS c FROM search_log")
    ).rows;
    expect(rows[0].c).toBe(2);
  });

  it("pruneExpired 显式短保留期可清理旧数据（未来撑不住时启用）", async () => {
    const now = 1_700_000_000_000;
    const day = 24 * 60 * 60_000;
    await store.logSearch({ openid: "o1", term: "老词", now: now - 200 * day });
    await store.logSearch({ openid: "o2", term: "新词", now });

    const pruned = await store.pruneExpired(now, 90 * day);
    expect(pruned).toBe(1); // 只删 200 天前的

    const rows = (
      await (store as any).client.execute("SELECT term FROM search_log")
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].term).toBe("新词");
  });
});
