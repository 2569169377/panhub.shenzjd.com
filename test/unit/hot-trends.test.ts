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

describe("SqliteHotSearchStore 词库与飙升", () => {
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

  it("getTrending 对比昨日排名：新上榜优先、上升靠前", async () => {
    const now = Date.now();
    const yesterday = dateKey(now - 86400000);
    const today = dateKey(now);

    // 直接构造昨日与今日快照（绕过懒生成，保证可控）
    const insert = (date: string, rows: [string, number, number][]) => {
      for (const [term, rank, score] of rows) {
        store.db.run(
          "INSERT OR REPLACE INTO rank_snapshots (snap_date, term, rank, score) VALUES (?, ?, ?, ?)",
          [date, term, rank, score]
        );
      }
    };
    insert(yesterday, [["A", 1, 10], ["B", 2, 8], ["C", 3, 6]]);
    insert(today, [["B", 1, 9], ["C", 2, 7], ["A", 3, 5], ["D", 4, 4]]);

    const trend = await store.getTrending(10);
    expect(trend).toHaveLength(4);
    // 新上榜 D 最前
    expect(trend[0].term).toBe("D");
    expect(trend[0].prevRank).toBeNull();
    // B 上升 1 位、C 上升 1 位，B 当前排名更靠前
    expect(trend[1].term).toBe("B");
    expect(trend[1].prevRank).toBe(2);
    expect(trend[1].delta).toBe(1);
    expect(trend[2].term).toBe("C");
    expect(trend[2].delta).toBe(1);
    // A 下降 2 位排最后
    expect(trend[3].term).toBe("A");
    expect(trend[3].delta).toBe(-2);
  });

  it("ensureTodaySnapshot 同一天只生成一次", async () => {
    await store.recordSearch("电影A", Date.now());
    await store.recordSearch("电影B", Date.now());
    await store.ensureTodaySnapshot();
    await store.ensureTodaySnapshot();
    const today = dateKey(Date.now());
    const result = store.db.exec("SELECT COUNT(*) as c FROM rank_snapshots WHERE snap_date = ?", [today]);
    expect(result[0].values[0][0]).toBe(2);
  });

  it("getTopTerms 按搜索次数降序，过滤低频与单字符词", async () => {
    const now = Date.now();
    // 剑来 ×3、仙逆 ×2、海 ×2（单字符应被过滤）、一次性词（count<2 应被过滤）
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

describe("MemoryHotSearchStore 词库与飙升", () => {
  let store: any;

  beforeEach(async () => {
    const { MemoryHotSearchStore } = await import("../../server/core/services/memoryHotSearchStore");
    store = new MemoryHotSearchStore();
  });

  afterEach(() => {
    store.close();
  });

  it("getTrending 新上榜优先、上升靠前", async () => {
    const now = Date.now();
    const yesterday = dateKey(now - 86400000);
    const today = dateKey(now);
    store.snapshots.set(yesterday, new Map([["A", 1], ["B", 2], ["C", 3]]));
    store.snapshots.set(today, new Map([["B", 1], ["C", 2], ["A", 3], ["D", 4]]));

    const trend = await store.getTrending(10);
    expect(trend.map((t: any) => t.term)).toEqual(["D", "B", "C", "A"]);
    expect(trend[0].prevRank).toBeNull();
    expect(trend[1].delta).toBe(1);
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
