/**
 * D1RestDatabase 单元测试（Docker 侧 D1 共享存储）
 *
 * mock globalThis.fetch 模拟 D1 REST API（行对象数组响应 + {batch:[...]} 请求格式），
 * 验证：批量 DDL 请求、recordSearch 的 SQL 分支、行映射、错误处理。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { D1RestDatabase, createD1RestHotSearchStore } from "../../server/core/services/d1RestHotSearchStore";
import { D1HotSearchStore } from "../../server/core/services/d1HotSearchStore";

const OPTS = {
  accountId: "acc-test",
  databaseId: "db-test",
  apiToken: "token-test",
};

/** 模拟 fetch 响应对象（含 json() 方法） */
const resp = (body: unknown) => ({ ok: true, json: async () => body });

/** 行对象数组响应（官方格式：result[i].results 直接是行对象） */
function d1Resp(rows: any[] = []) {
  return resp({
    success: true,
    result: [{ results: rows, success: true, meta: {} }],
  });
}

function d1Err(message: string) {
  return resp({ success: false, errors: [{ message }], result: [] });
}

/** 解析 fetch mock 第 n 次调用的请求体 → 统一为查询数组（兼容 {batch:[...]} 与单对象） */
function bodyOf(mock: ReturnType<typeof vi.fn>, n: number): Array<{ sql: string; params?: unknown[] }> {
  const body = JSON.parse(mock.mock.calls[n][1].body);
  return Array.isArray(body) ? body : Array.isArray(body.batch) ? body.batch : [body];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("D1RestDatabase", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it("配置缺失时抛错", () => {
    const old = { ...process.env };
    delete process.env.D1_ACCOUNT_ID;
    delete process.env.D1_DATABASE_ID;
    delete process.env.D1_API_TOKEN;
    expect(() => new D1RestDatabase({ fetchImpl: fetchMock as any })).toThrow(/配置缺失/);
    Object.assign(process.env, old);
  });

  it("init 用 batch 一次发送全部 DDL", async () => {
    fetchMock.mockResolvedValue(d1Resp());
    const store = createD1RestHotSearchStore({ ...OPTS, fetchImpl: fetchMock as any });
    await sleep(20); // 等 init 完成

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const reqs = bodyOf(fetchMock, 0);
    expect(Array.isArray(reqs)).toBe(true);
    expect(reqs.length).toBe(6); // 2 张表 + 4 个索引
    expect(reqs[0].sql).toContain("CREATE TABLE IF NOT EXISTS hot_searches");
    expect(reqs[3].sql).toContain("CREATE TABLE IF NOT EXISTS search_terms");
    store.close();
  });

  it("recordSearch 新词走 INSERT 分支并带参数", async () => {
    // 顺序：init batch → SELECT hot_searches(空) → INSERT hot_searches
    //      → SELECT search_terms(空) → INSERT search_terms → DELETE 过期 → DELETE 截断
    fetchMock.mockResolvedValueOnce(d1Resp()); // init
    fetchMock.mockResolvedValueOnce(d1Resp()); // SELECT hot_searches → 空（新词）
    fetchMock.mockResolvedValueOnce(d1Resp()); // INSERT hot_searches
    fetchMock.mockResolvedValueOnce(d1Resp()); // SELECT search_terms → 空
    fetchMock.mockResolvedValueOnce(d1Resp()); // INSERT search_terms
    fetchMock.mockResolvedValueOnce(d1Resp()); // DELETE 过期词
    fetchMock.mockResolvedValueOnce(d1Resp()); // DELETE 截断

    const store = createD1RestHotSearchStore({ ...OPTS, fetchImpl: fetchMock as any });
    await sleep(20);
    const now = Date.now();
    await store.recordSearch("测试新词", now);

    // 找到 INSERT hot_searches 请求并验证参数
    let insertFound = false;
    let paramsOk = false;
    for (let i = 1; i < fetchMock.mock.calls.length; i++) {
      const reqs = bodyOf(fetchMock, i);
      for (const r of reqs) {
        if (r.sql.includes("INSERT INTO hot_searches")) {
          insertFound = true;
          // 新词默认 delta=1：term, score(=delta), last_searched_at, created_at
          paramsOk =
            r.params?.[0] === "测试新词" &&
            r.params?.[1] === 1 &&
            r.params?.[2] === now &&
            r.params?.[3] === now;
        }
      }
    }
    expect(insertFound).toBe(true);
    expect(paramsOk).toBe(true);
    store.close();
  });

  it("getHotSearches 正确映射行对象响应", async () => {
    fetchMock.mockResolvedValueOnce(d1Resp()); // init
    fetchMock.mockResolvedValueOnce(
      d1Resp([
        {
          term: "电影",
          score: 5,
          last_searched_at: 1786000000000,
          created_at: 1785000000000,
          decayed_score: 4.2,
        },
      ])
    );

    const store = createD1RestHotSearchStore({ ...OPTS, fetchImpl: fetchMock as any });
    await sleep(20);
    const items = await store.getHotSearches(10);

    expect(items).toHaveLength(1);
    expect(items[0].term).toBe("电影");
    expect(items[0].score).toBe(5);
    expect(items[0].displayScore).toBeCloseTo(4.2);
    expect(items[0].rank).toBe(1);
    store.close();
  });

  it("REST 错误响应抛错", async () => {
    fetchMock.mockResolvedValueOnce(d1Resp()); // init
    fetchMock.mockResolvedValueOnce(d1Err("sql logic error"));

    const store = createD1RestHotSearchStore({ ...OPTS, fetchImpl: fetchMock as any });
    await sleep(20);
    await expect(store.getHotSearches(10)).rejects.toThrow(/sql logic error/);
    store.close();
  });

  it("D1HotSearchStore 可注入 REST 适配器（类型/契约兼容）", () => {
    fetchMock.mockResolvedValue(d1Resp()); // 构造函数触发 init 的 batch fetch
    const db = new D1RestDatabase({ ...OPTS, fetchImpl: fetchMock as any });
    const store = new D1HotSearchStore(db as any);
    expect(store).toBeInstanceOf(D1HotSearchStore);
    store.close();
  });
});
