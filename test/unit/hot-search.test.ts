/**
 * 热搜功能测试（service 层）
 * 使用独立测试库（HOT_SEARCH_DB_PATH 环境变量），绝不污染 data/hot-searches.db（线上数据副本）
 *
 * 语义说明：写路径为「内存聚合 + 异步批量落盘」，读路径直接读 store（写读分离）。
 * 因此测试在「写」后显式 await service.flush() 再「读」，模拟增量落盘后的读取。
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync } from "fs";
import type { HotSearchService } from "../../server/core/services/hotSearchService";

// 独立目录，避免与 sqliteHotSearch.test.ts 共用 ./data-test（其 afterAll 会递归删除该目录，
// vitest 并行执行时会把本测试的 db 一起删掉导致偶发失败）
const TEST_DB_PATH = "./data-test-service/hot-search-service.db";

describe("HotSearchService (SQLite store, isolated db)", () => {
  let service: HotSearchService;
  let resetHotSearchService: () => void;

  beforeAll(async () => {
    process.env.HOT_SEARCH_DB_PATH = TEST_DB_PATH;
    const mod = await import("../../server/core/services/hotSearchService");
    resetHotSearchService = mod.resetHotSearchService;
    service = mod.getOrCreateHotSearchService();
    await service.clearHotSearches();
  });

  afterAll(() => {
    resetHotSearchService();
    delete process.env.HOT_SEARCH_DB_PATH;
    try {
      rmSync(TEST_DB_PATH, { force: true });
    } catch {}
  });

  it("应该能够记录搜索词（flush 后可见）", async () => {
    await service.clearHotSearches();
    await service.recordSearch("测试电影");
    await service.flush();

    const searches = await service.getHotSearches(10);
    expect(searches.length).toBeGreaterThan(0);
    expect(searches[0].term).toBe("测试电影");
    expect(searches[0].score).toBeCloseTo(1, 5);
  });

  it("同词多次搜索应合并为一次增量写入", async () => {
    await service.clearHotSearches();
    await service.recordSearch("聚合词");
    await service.recordSearch("聚合词");
    await service.recordSearch("聚合词");
    await service.flush();

    const searches = await service.getHotSearches(10);
    const item = searches.find((s) => s.term === "聚合词");
    expect(item?.score).toBeCloseTo(3, 5);
  });

  it("未 flush 时读不到缓冲中的增量（写读分离）", async () => {
    await service.clearHotSearches();
    await service.recordSearch("未落盘词");
    // 不 flush，直接读：缓冲未落盘，榜单应读不到该词
    const searches = await service.getHotSearches(50);
    expect(searches.some((s) => s.term === "未落盘词")).toBe(false);
  });

  it("应该能够获取热搜列表", async () => {
    await service.clearHotSearches();
    await service.recordSearch("电影");
    await service.recordSearch("软件");
    await service.recordSearch("学习资料");
    await service.flush();

    const searches = await service.getHotSearches(5);
    expect(searches.length).toBeLessThanOrEqual(5);
    expect(searches.length).toBeGreaterThan(0);
  });

  it("应该能够获取统计信息", async () => {
    await service.recordSearch("统计词");
    await service.flush();

    const stats = await service.getStats();
    expect(stats.total).toBeGreaterThan(0);
    expect(stats.topTerms).toBeInstanceOf(Array);
  });

  it("应该过滤违规词", async () => {
    await service.clearHotSearches();
    await service.recordSearch("政治敏感词");
    await service.recordSearch("暴力内容");
    await service.recordSearch("正常搜索词");
    await service.flush();

    const searches = await service.getHotSearches(50);
    const hasForbidden = searches.some(
      (s) => s.term.includes("政治") || s.term.includes("暴力")
    );
    expect(hasForbidden).toBe(false);
    expect(searches.some((s) => s.term === "正常搜索词")).toBe(true);
  });

  it("应该限制最大条目数", async () => {
    await service.clearHotSearches();
    for (let i = 0; i < 60; i++) {
      await service.recordSearch(`测试词${i}`);
    }
    await service.flush();

    const searches = await service.getHotSearches(100);
    expect(searches.length).toBeLessThanOrEqual(30);
  });

  it("应该按分数排序", async () => {
    await service.clearHotSearches();
    await service.recordSearch("高分词");
    await service.recordSearch("高分词");
    await service.recordSearch("高分词");
    await service.recordSearch("低分词");
    await service.flush();

    const searches = await service.getHotSearches(10);
    expect(searches[0].term).toBe("高分词");
    expect(searches[0].score).toBeCloseTo(3, 5);
    expect(searches[1].term).toBe("低分词");
    expect(searches[1].score).toBeCloseTo(1, 5);
  });

  it("应该处理空搜索词", async () => {
    await service.clearHotSearches();
    await service.recordSearch("");
    await service.recordSearch("   ");
    await service.flush();

    const searches = await service.getHotSearches(100);
    expect(searches.length).toBe(0);
  });

  it("应该处理超长搜索词", async () => {
    await service.clearHotSearches();
    await service.recordSearch("a".repeat(101));
    await service.flush();

    const searches = await service.getHotSearches(100);
    expect(searches.length).toBe(0);
  });

  it("应该返回文件大小（或 0）", async () => {
    const size = service.getDatabaseSize();
    expect(typeof size).toBe("number");
    expect(size).toBeGreaterThanOrEqual(0);
  });

  it("应该返回今日随机热搜词（service 层转发冒烟）", async () => {
    await service.clearHotSearches();
    await service.recordSearch("随机词A");
    await service.recordSearch("随机词B");
    await service.flush();

    const searches = await service.getRandomHotSearches(10);
    expect(searches.length).toBeLessThanOrEqual(10);
    for (const s of searches) {
      expect(typeof s.term).toBe("string");
      expect(s.term.length).toBeGreaterThan(0);
    }
  });
});
