/**
 * TursoHotSearchStore 单元测试
 *
 * 用 @libsql/client 的 file: 本地内存库（file::memory:）跑真实 SQL，
 * 验证 recordSearch(delta 合并)/衰减/日历/词单/清理等行为与 sqlite/d1 实现语义一致。
 * 不依赖线上 Turso（无网络、无凭据）。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TursoHotSearchStore } from "../../server/core/services/tursoHotSearchStore";

/** 北京时间（UTC+8）日期键，与实现保持一致 */
function dateKey(ts: number): string {
  const d = new Date(ts + 8 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

describe("TursoHotSearchStore", () => {
  let store: TursoHotSearchStore;

  beforeEach(async () => {
    store = new TursoHotSearchStore("file::memory:");
    await (store as any).waitForInit();
  });

  afterEach(() => {
    store.close();
  });

  it("recordSearch 新词写入热搜与词库（delta=1）", async () => {
    const now = Date.now();
    await store.recordSearch("测试电影", now);

    const hot = await store.getHotSearches(10);
    expect(hot.length).toBe(1);
    expect(hot[0].term).toBe("测试电影");
    expect(hot[0].score).toBeCloseTo(1, 5);

    const terms = await store.getTopTerms(10);
    expect(terms.length).toBe(0); // count=1 < 2，不满足 getTopTerms 门槛
  });

  it("recordSearch 支持 delta 合并（一次写入 count+N）", async () => {
    const now = Date.now();
    await store.recordSearch("热词", now, 5);
    await store.recordSearch("热词", now, 3); // 同一时刻，无衰减

    const hot = await store.getHotSearches(10);
    const item = hot.find((s) => s.term === "热词");
    expect(item?.score).toBeCloseTo(8, 4); // 5 + 3

    const terms = await store.getTopTerms(10);
    expect(terms).toEqual([{ term: "热词", count: 8 }]);
  });

  it("recordSearch 已有词分数递增（无衰减时 +1）", async () => {
    const t0 = Date.now();
    await store.recordSearch("热门词", t0);
    await store.recordSearch("热门词", t0 + 1000);
    await store.recordSearch("热门词", t0 + 2000);

    const hot = await store.getHotSearches(10);
    const item = hot.find((s) => s.term === "热门词");
    expect(item?.score).toBeCloseTo(3, 4);
  });

  it("recordSearch 分数随时间指数衰减", async () => {
    const t0 = Date.now();
    await store.recordSearch("衰减词", t0);
    await store.recordSearch("衰减词", t0 + 86400000); // 1 天后再搜

    const hot = await store.getHotSearches(10);
    const item = hot.find((s) => s.term === "衰减词");
    expect(item?.score).toBeCloseTo(1 + Math.exp(-1), 3);
  });

  it("过滤非法词条（URL/敏感词/空串/超长）", async () => {
    const now = Date.now();
    await store.recordSearch("https://example.com", now);
    await store.recordSearch("赌博网站", now);
    await store.recordSearch("   ", now);
    await store.recordSearch("a".repeat(21), now);

    const hot = await store.getHotSearches(10);
    expect(hot.length).toBe(0);
  });

  it("全角转半角规范化", async () => {
    const now = Date.now();
    await store.recordSearch("ＡＢＣ电影", now);
    const hot = await store.getHotSearches(10);
    expect(hot[0].term).toBe("ABC电影");
  });

  it("getHotSearches 按热度排序并带 displayScore", async () => {
    const now = Date.now();
    await store.recordSearch("冷词", now);
    for (let i = 0; i < 5; i++) await store.recordSearch("热词", now);

    const hot = await store.getHotSearches(10);
    expect(hot[0].term).toBe("热词");
    expect(hot[0].displayScore).toBeGreaterThan(hot[1].displayScore);
    expect(hot[0].rank).toBe(1);
  });

  it("getRandomHotSearches 只返回北京时间今日的词", async () => {
    const now = Date.now();
    await store.recordSearch("今日词", now);
    await store.recordSearch("昨日词", now - 2 * 86400000);

    const samples = await store.getRandomHotSearches(25);
    const terms = samples.map((s) => s.term);
    expect(terms).toContain("今日词");
    expect(terms).not.toContain("昨日词");
  });

  it("getTopTerms 只返回 count>=2 且长度>=2 的词", async () => {
    const now = Date.now();
    await store.recordSearch("电影", now);
    await store.recordSearch("电影", now);
    await store.recordSearch("电", now); // 长度 1，排除
    await store.recordSearch("孤", now);
    await store.recordSearch("孤", now); // 长度 1，排除

    const terms = await store.getTopTerms(10);
    expect(terms).toEqual([{ term: "电影", count: 2 }]);
  });

  it("getCalendar 返回连续日期与每天 top3", async () => {
    const now = Date.now();
    await store.recordSearch("词甲", now);
    await store.recordSearch("词乙", now);
    await store.recordSearch("词乙", now);
    await store.recordSearch("词丙", now);
    await store.recordSearch("词丙", now);
    await store.recordSearch("词丙", now);

    const calendar = await store.getCalendar(3);
    expect(calendar.length).toBe(3);
    const today = calendar[calendar.length - 1];
    expect(today.date).toBe(dateKey(now));
    expect(today.count).toBe(3);
    expect(today.top).toEqual(["词丙", "词乙", "词甲"]);
  });

  it("getDayItems 返回指定日期词单", async () => {
    const now = Date.now();
    await store.recordSearch("日词1", now);
    await store.recordSearch("日词2", now);
    await store.recordSearch("日词2", now);

    const today = dateKey(now);
    const items = await store.getDayItems(today);
    expect(items.length).toBe(2);
    expect(items[0]).toEqual({ term: "日词2", rank: 1, count: 2 });
  });

  it("deleteHotSearch 删除与容错", async () => {
    const now = Date.now();
    await store.recordSearch("待删词", now);

    const ok = await store.deleteHotSearch("待删词");
    expect(ok.success).toBe(true);
    expect((await store.getHotSearches(10)).length).toBe(0);

    const miss = await store.deleteHotSearch("不存在");
    expect(miss.success).toBe(false);
  });

  it("clearHotSearches 清空热搜表（保留词库）", async () => {
    const now = Date.now();
    await store.recordSearch("清空词", now);

    const res = await store.clearHotSearches();
    expect(res.success).toBe(true);
    expect((await store.getHotSearches(10)).length).toBe(0);
    expect((await store.getTopTerms(10)).length).toBe(0);
  });

  it("cleanupOldEntries 截断到 maxEntries 且清理过期词", async () => {
    const now = Date.now();
    for (let i = 0; i < 35; i++) {
      await store.recordSearch(`词${i}`, now);
    }
    const hot = await store.getHotSearches(100);
    expect(hot.length).toBe(30); // 默认 MAX_ENTRIES

    const oldStore = new TursoHotSearchStore("file::memory:");
    await (oldStore as any).waitForInit();
    await oldStore.recordSearch("旧词", now - 3 * 86400000);
    await oldStore.recordSearch("新词", now);
    await oldStore.cleanupOldEntries(30);
    const list = await oldStore.getHotSearches(100);
    expect(list.map((s) => s.term)).toEqual(["新词"]);
    oldStore.close();
  });
});
