import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";

const TEST_DB_DIR = "./data-test-terms";
const TEST_DB_PATH = "./data-test-terms/test-terms.db";

function dateKey(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

describe("SqliteHotSearchStore 日历与全量快照", () => {
  let store: any;

  beforeAll(async () => {
    if (!existsSync(TEST_DB_DIR)) {
      mkdirSync(TEST_DB_DIR, { recursive: true });
    }
  });

  afterAll(() => {
    if (store) store.close();
    if (existsSync(TEST_DB_DIR)) {
      rmSync(TEST_DB_DIR, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    if (store) store.close();
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH, { force: true });
    }
    const { SqliteHotSearchStore } = await import("../../server/core/services/sqliteHotSearchStore");
    store = new SqliteHotSearchStore(TEST_DB_PATH);
    await store.waitForInit();
  });

  it("ensureTodaySnapshot 记录当天全部词（非仅 top30）", async () => {
    const now = Date.now();
    for (let i = 0; i < 40; i++) {
      await store.recordSearch(`词${String(i).padStart(2, "0")}`, now + i * 1000);
    }
    await store.ensureTodaySnapshot();
    const today = dateKey(now);
    const result = store.db.exec("SELECT COUNT(*) as c FROM rank_snapshots WHERE snap_date = ?", [today]);
    // 40 个词全部进入快照，不再限制 30 条
    expect(result[0].values[0][0]).toBe(40);
  });

  it("getCalendar 返回近 N 天连续日期与每天词数/top3", async () => {
    const now = Date.now();
    await store.recordSearch("词A", now);
    await store.recordSearch("词A", now + 1000); // count=2 热度最高
    await store.recordSearch("词B", now + 2000);
    await store.recordSearch("词C", now + 3000);
    await store.ensureTodaySnapshot();

    const cal = await store.getCalendar(5);
    expect(cal).toHaveLength(5);
    const today = dateKey(now);
    const todayEntry = cal.find((d: any) => d.date === today);
    expect(todayEntry.count).toBe(3);
    expect(todayEntry.top[0]).toBe("词A");
    // 其他日期无数据
    const others = cal.filter((d: any) => d.date !== today);
    expect(others.every((d: any) => d.count === 0)).toBe(true);
  });

  it("getDayItems 返回指定日期全量词单，无数据返回空", async () => {
    const now = Date.now();
    await store.recordSearch("词A", now);
    await store.recordSearch("词A", now + 1000);
    await store.recordSearch("词B", now + 2000);
    await store.ensureTodaySnapshot();

    const today = dateKey(now);
    const items = await store.getDayItems(today);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ term: "词A", rank: 1, count: 2 });
    expect(items[1]).toEqual({ term: "词B", rank: 2, count: 1 });

    expect(await store.getDayItems("2020-01-01")).toEqual([]);
    expect(await store.getDayItems("bad-date")).toEqual([]);
  });

  it("getTrending 对比昨日排名：新上榜优先、上升靠前", async () => {
    const now = Date.now();
    const yesterday = dateKey(now - 86400000);
    const today = dateKey(now);

    // 今日有 4 个词（搜索顺序 B→C→A→D，D 最新）
    await store.recordSearch("B", now);
    await store.recordSearch("C", now + 1000);
    await store.recordSearch("A", now + 2000);
    await store.recordSearch("D", now + 3000);

    // 昨日快照手动构造（昨日 3 词）
    for (const [term, rank, score] of [["A", 1, 10], ["B", 2, 8], ["C", 3, 6]] as [string, number, number][]) {
      store.db.run(
        "INSERT OR REPLACE INTO rank_snapshots (snap_date, term, rank, score) VALUES (?, ?, ?, ?)",
        [yesterday, term, rank, score]
      );
    }

    const trend = await store.getTrending(10);
    // 今日快照由 search_terms 生成：count 全为 1 → 按 last_at DESC → D,A,C,B
    expect(trend.map((t: any) => t.term)).toEqual(["D", "C", "A", "B"]);
    // D 新上榜
    expect(trend[0].prevRank).toBeNull();
    // C 昨日 3 → 今日 3，持平
    expect(trend[1].term).toBe("C");
    expect(trend[1].delta).toBe(0);
    // A 昨日 1 → 今日 2，下降 1
    expect(trend[2].term).toBe("A");
    expect(trend[2].delta).toBe(-1);
    // B 昨日 2 → 今日 4，下降 2
    expect(trend[3].term).toBe("B");
    expect(trend[3].delta).toBe(-2);
  });

  it("getTopTerms 按搜索次数降序，过滤低频与单字符词", async () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) await store.recordSearch("剑来", now + i * 1000);
    for (let i = 0; i < 2; i++) await store.recordSearch("仙逆", now + i * 1000);
    for (let i = 0; i < 2; i++) await store.recordSearch("海", now + i * 1000);
    await store.recordSearch("仅一次", now);

    const top = await store.getTopTerms(10);
    expect(top.map((t: any) => t.term)).toEqual(["剑来", "仙逆"]);
    expect(top[0].count).toBe(3);
    expect(top[1].count).toBe(2);
  });

  it("从日志初始化词库（幂等）", async () => {
    const logFile = resolve(TEST_DB_DIR, "seed-test.log");
    writeFileSync(
      logFile,
      [
        `[2026-08-09T14:27:48.589Z] [INFO] [HotSearch] 新词出现 {`,
        `  "term": "慕尼黑 战争边缘"`,
        `}`,
        `[2026-08-09T14:28:04.330Z] [INFO] [HotSearch] 新词出现 {`,
        `  "term": "慕尼黑"`,
        `}`,
      ].join("\n"),
      "utf-8"
    );

    store.close();
    const { SqliteHotSearchStore } = await import("../../server/core/services/sqliteHotSearchStore");
    store = new SqliteHotSearchStore(TEST_DB_PATH);
    await store.waitForInit();

    const result = store.db.exec("SELECT term FROM search_terms ORDER BY term ASC");
    const terms = result[0].values.map((row: any[]) => row[0]);
    expect(terms).toEqual(["慕尼黑", "慕尼黑 战争边缘"]);

    // 再次实例化不应重复导入（幂等）
    store.close();
    store = new SqliteHotSearchStore(TEST_DB_PATH);
    await store.waitForInit();
    const again = store.db.exec("SELECT COUNT(*) as c FROM search_terms");
    expect(again[0].values[0][0]).toBe(2);

    rmSync(logFile, { force: true });
  });
});

describe("MemoryHotSearchStore 日历与全量快照", () => {
  let store: any;

  beforeEach(async () => {
    const { MemoryHotSearchStore } = await import("../../server/core/services/memoryHotSearchStore");
    store = new MemoryHotSearchStore();
  });

  afterEach(() => {
    store.close();
  });

  it("getCalendar 与 getDayItems 返回当天全量词", async () => {
    const now = Date.now();
    await store.recordSearch("词A", now);
    await store.recordSearch("词A", now + 1000);
    await store.recordSearch("词B", now + 2000);
    await store.ensureTodaySnapshot();

    const today = dateKey(now);
    const cal = await store.getCalendar(5);
    expect(cal).toHaveLength(5);
    const todayEntry = cal.find((d: any) => d.date === today);
    expect(todayEntry.count).toBe(2);
    expect(todayEntry.top[0]).toBe("词A");

    const items = await store.getDayItems(today);
    expect(items[0]).toEqual({ term: "词A", rank: 1, count: 2 });
    expect(items[1]).toEqual({ term: "词B", rank: 2, count: 1 });
  });

  it("getTrending 新上榜优先、上升靠前", async () => {
    const now = Date.now();
    const yesterday = dateKey(now - 86400000);
    // 今日 4 词（搜索顺序 B→C→A→D）
    await store.recordSearch("B", now);
    await store.recordSearch("C", now + 1000);
    await store.recordSearch("A", now + 2000);
    await store.recordSearch("D", now + 3000);
    // 昨日快照手动构造
    store.snapshots.set(
      yesterday,
      new Map([["A", { rank: 1, count: 10 }], ["B", { rank: 2, count: 8 }], ["C", { rank: 3, count: 6 }]])
    );

    const trend = await store.getTrending(10);
    expect(trend.map((t: any) => t.term)).toEqual(["D", "C", "A", "B"]);
    expect(trend[0].prevRank).toBeNull();
    expect(trend[1].delta).toBe(0);
    expect(trend[2].delta).toBe(-1);
    expect(trend[3].delta).toBe(-2);
  });

  it("getTopTerms 按搜索次数降序过滤低频词", async () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) await store.recordSearch("剑来", now + i * 1000);
    for (let i = 0; i < 2; i++) await store.recordSearch("仙逆", now + i * 1000);
    await store.recordSearch("仅一次", now);

    const top = await store.getTopTerms(10);
    expect(top.map((t: any) => t.term)).toEqual(["剑来", "仙逆"]);
    expect(top[0].count).toBe(3);
  });
});
