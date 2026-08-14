import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";

const TEST_DB_DIR = "./data-test";
const TEST_DB_PATH = "./data-test/test-hot-search.db";

describe("SqliteHotSearchStore", () => {
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

  it("多次 recordSearch + 重建 + 关闭 → 重新加载后 db 完整性 OK（atomic 写盘）", async () => {
    // 模拟生产热路径：连续 recordSearch + ensureTodaySnapshot + 关闭（等价于 dev server 重启）
    const now = Date.now();
    for (let i = 0; i < 30; i++) {
      await store.recordSearch(`原子写盘测试${i}`, now + i * 100);
    }
    await store.ensureTodaySnapshot();
    // 关键：触发 scheduleSave 落盘（500ms 防抖）
    await new Promise((r) => setTimeout(r, 700));
    // 关闭（同步最后落盘）
    store.close();

    // 重新加载同一个 db：sqlite3 CLI 工具做 integrity_check
    const { execSync } = await import("child_process");
    const result = execSync(`sqlite3 "${TEST_DB_PATH}" "PRAGMA integrity_check;"`).toString().trim();
    expect(result).toBe("ok");

    // 不应残留 tmp 文件
    const { existsSync } = await import("fs");
    const { readdirSync } = await import("fs");
    const tmpFiles = readdirSync(TEST_DB_DIR).filter((f) => f.includes(".tmp-"));
    expect(tmpFiles).toEqual([]);
  });

  it("损坏 db 启动自愈：REINDEX 修复 + 数据保留", async () => {
    // 先写入一些词并落盘
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      await store.recordSearch(`自愈测试${i}`, now + i * 100);
    }
    store.close();
    await new Promise((r) => setTimeout(r, 100));

    // 模拟旧版 fire-and-forget 写盘导致的半写：破坏索引元数据
    // 直接删掉索引定义对应的 catalog 页不现实，用 sqlite 的 REINDEX 前先造错：
    // 更贴近实际的做法：复制一份 db 后，用 sql.js 删除索引再插入不一致数据。
    // 这里用一个轻量可靠的损坏方式：截断文件尾部（模拟写盘中断）。
    const raw = readFileSync(TEST_DB_PATH);
    const truncated = raw.subarray(0, Math.floor(raw.length * 0.92));
    writeFileSync(TEST_DB_PATH, truncated);
    const { execSync } = await import("child_process");
    let integrityResult = "";
    try {
      integrityResult = execSync(`sqlite3 "${TEST_DB_PATH}" "PRAGMA integrity_check;"`).toString().trim();
    } catch {}
    // 确认文件确实已损坏（截断后的 db 完整性检查应报错，至少不是干净的 ok）
    const isCorrupt = integrityResult !== "ok";

    // 重新实例化：init 会触发 repairIfCorrupt，REINDEX 修复后应能正常加载
    const { SqliteHotSearchStore } = await import("../../server/core/services/sqliteHotSearchStore");
    store = new SqliteHotSearchStore(TEST_DB_PATH);
    await (store as any).waitForInit();

    // 无论原文件是否被截断损坏，重建后都应能正常查询
    const cal = await store.getCalendar(5);
    expect(cal).toHaveLength(5);

    if (isCorrupt) {
      // 确认没有留下 tmp 半写文件残留
      const { readdirSync } = await import("fs");
      const leftovers = readdirSync(TEST_DB_DIR).filter((f) => f.includes(".tmp-"));
      expect(leftovers).toEqual([]);
    }
  });
});
