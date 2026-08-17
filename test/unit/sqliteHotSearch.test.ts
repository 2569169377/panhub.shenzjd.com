import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "fs";
import { randomUUID } from "node:crypto";

const TEST_DB_DIR = "./data-test";

describe("SqliteHotSearchStore", () => {
  let store: any;

  beforeAll(async () => {
    if (!existsSync(TEST_DB_DIR)) {
      mkdirSync(TEST_DB_DIR, { recursive: true });
    }
  });

  afterAll(() => {
    if (store) {
      try { store.close(); } catch {}
    }
    // 尽力清理；删除失败（如沙箱防护拦截）时忽略，data-test* 已 gitignore
    try { rmSync(TEST_DB_DIR, { recursive: true, force: true }); } catch {}
  });

  beforeEach(async () => {
    if (store) {
      try { store.close(); } catch {}
    }
    // 每个测试用独立子目录 + UUID db 文件：天然隔离且无并发竞争；
    // 不做任何删除操作（避免沙箱防护拦截 rmSync），data-test* 已 gitignore
    const { SqliteHotSearchStore } = await import("../../server/core/services/sqliteHotSearchStore");
    store = new SqliteHotSearchStore(`${TEST_DB_DIR}/t-${randomUUID()}/test.db`);
    await (store as any).waitForInit();
  });

  it("should record a search term", async () => {
    await store.recordSearch("星际穿越", Date.now());
    const items = await store.getHotSearches(10);
    expect(items).toHaveLength(1);
    expect(items[0].term).toBe("星际穿越");
    expect(items[0].score).toBeCloseTo(1, 5);
  });

  it("should increment score for repeated searches", async () => {
    const now = Date.now();
    await store.recordSearch("海王", now);
    await store.recordSearch("海王", now + 1000);
    await store.recordSearch("海王", now + 2000);
    const items = await store.getHotSearches(10);
    expect(items).toHaveLength(1);
    expect(items[0].score).toBeCloseTo(3, 4);
  });

  it("should normalize full-width characters", async () => {
    await store.recordSearch("Ｈｅｌｌｏ", Date.now());
    const items = await store.getHotSearches(10);
    expect(items[0].term).toBe("Hello");
  });

  it("should reject URLs", async () => {
    await store.recordSearch("https://www.aliyundrive.com/s/abc", Date.now());
    const items = await store.getHotSearches(10);
    expect(items).toHaveLength(0);
  });

  it("should reject terms longer than 20 characters", async () => {
    await store.recordSearch("这是一段超过二十个字符的搜索词用来测试长度限制功能是否正常工作", Date.now());
    const items = await store.getHotSearches(10);
    expect(items).toHaveLength(0);
  });

  it("should reject forbidden terms", async () => {
    await store.recordSearch("色情内容", Date.now());
    const items = await store.getHotSearches(10);
    expect(items).toHaveLength(0);
  });

  it("should return items with rank and displayScore", async () => {
    await store.recordSearch("电影A", Date.now());
    await store.recordSearch("电影B", Date.now());
    const items = await store.getHotSearches(10);
    expect(items[0].rank).toBe(1);
    expect(items[0].displayScore).toBeDefined();
    expect(typeof items[0].displayScore).toBe("number");
  });

  it("should delete a search term", async () => {
    await store.recordSearch("要删除的词", Date.now());
    const result = await store.deleteHotSearch("要删除的词");
    expect(result.success).toBe(true);
    const items = await store.getHotSearches(10);
    expect(items).toHaveLength(0);
  });

  it("should clear all entries", async () => {
    await store.recordSearch("词1", Date.now());
    await store.recordSearch("词2", Date.now());
    await store.clearHotSearches();
    const items = await store.getHotSearches(10);
    expect(items).toHaveLength(0);
  });

  it("should return correct stats", async () => {
    await store.recordSearch("统计测试1", Date.now());
    await store.recordSearch("统计测试2", Date.now());
    const stats = await store.getStats();
    expect(stats.total).toBe(2);
    expect(stats.topTerms).toHaveLength(2);
  });

  it("getRandomHotSearches should only return today's terms", async () => {
    const now = Date.now();
    await store.recordSearch("今日词1", now);
    await store.recordSearch("今日词2", now);
    await store.recordSearch("今日词3", now);
    // 昨天的词：仍在 search_terms 词库中，但 last_at 不在今日窗口内
    await store.recordSearch("昨日词", now - 2 * 86400000);

    const items = await store.getRandomHotSearches(10);
    const terms = items.map((i: any) => i.term);
    expect(items.length).toBeGreaterThan(0);
    expect(terms).not.toContain("昨日词");
  });

  it("getRandomHotSearches should respect limit and return compatible shape", async () => {
    const now = Date.now();
    for (let i = 0; i < 8; i++) {
      await store.recordSearch(`随机词${i}`, now);
    }
    const items = await store.getRandomHotSearches(3);
    expect(items).toHaveLength(3);
    expect(items[0].term).toBeDefined();
    expect(items[0].rank).toBe(1);
    expect(typeof items[0].displayScore).toBe("number");
  });
});
