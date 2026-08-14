/**
 * HotSearchService 日历自愈测试
 *
 * 修复：当 recordSearch 不主动调用 ensureTodaySnapshot 时（生产路径现状），
 * 日历接口应自动重建今日快照；30 秒内同进程多次访问不应重复重建；
 * 历史日期查询不应误触发今日重建。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { HotSearchService } from "../../server/core/services/hotSearchService";
import type { IHotSearchStore } from "../../server/core/services/hotSearchStore";

/** Spy store：记录 ensureTodaySnapshot 调用次数，其余接口返回可控的 fake 数据 */
function createSpyStore(): IHotSearchStore & { snapshotCalls: number; cleanupCalls: number } {
  const obj: any = {
    snapshotCalls: 0,
    cleanupCalls: 0,
    async recordSearch() {
      return;
    },
    async getHotSearches() {
      return [];
    },
    async cleanupOldEntries() {
      obj.cleanupCalls++;
    },
    async clearHotSearches() {
      return { success: true, message: "ok" };
    },
    async deleteHotSearch() {
      return { success: false, message: "nope" };
    },
    async getStats() {
      return { total: 0, topTerms: [] };
    },
    async ensureTodaySnapshot() {
      obj.snapshotCalls++;
    },
    async getCalendar(days: number) {
      const out = [];
      const today = new Date();
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(today.getTime() - i * 86400000);
        const pad = (n: number) => String(n).padStart(2, "0");
        out.push({
          date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
          count: 0,
          top: [],
        });
      }
      return out;
    },
    async getDayItems() {
      return [];
    },
    async getTopTerms() {
      return [];
    },
    close() {},
  };
  return obj;
}

describe("HotSearchService 日历自愈", () => {
  let store: any;
  let service: HotSearchService;

  beforeEach(() => {
    store = createSpyStore();
    // 直接 new，绕开 globalThis 单例，保证每个测试都是干净的 instance
    service = new HotSearchService();
    // service 初始化时是同步设置 memoryStore，initPromise 异步切到 sqlite；这里强注入 spy
    (service as any).store = store;
    (service as any).initPromise = null;
  });

  it("getCalendar 应触发 ensureTodaySnapshot（自愈今日数据）", async () => {
    await service.getCalendar(7);
    expect(store.snapshotCalls).toBe(1);
  });

  it("getDayItems(今天) 应触发 ensureTodaySnapshot", async () => {
    const today = (() => {
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    })();
    await service.getDayItems(today);
    expect(store.snapshotCalls).toBe(1);
  });

  it("getDayItems(历史日期) 不应触发 ensureTodaySnapshot", async () => {
    await service.getDayItems("2020-01-01");
    expect(store.snapshotCalls).toBe(0);
  });

  it("30s 内多次 getCalendar 只触发一次 ensureTodaySnapshot（memo）", async () => {
    await service.getCalendar(7);
    await service.getCalendar(14);
    await service.getCalendar(30);
    await service.getDayItems((() => {
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    })());
    expect(store.snapshotCalls).toBe(1);
  });
});
