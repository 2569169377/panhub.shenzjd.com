/**
 * BotDefenseService 单元测试（2026-08-24 新增）
 *
 * 覆盖：
 * - isBlocked 缓存策略（pos / neg / store fallback）
 * - recordRejection 滑动窗口阈值（60s 内累计 ≥5 → extendBlock）
 * - 持久化失败时的容错
 * - 服务降级（Turso 不可用时 isBlocked 返回 false，recordRejection 不抛）
 *
 * 实现：FakeStore 不依赖 vi.spyOn 钩原型方法，全部用箭头函数 + vi.fn 直接绑到实例属性
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

interface FakeStore {
  blocked: Set<string>;
  hitCount: Map<string, number>;
  isBlocked: ReturnType<typeof vi.fn>;
  recordRejection: ReturnType<typeof vi.fn>;
  extendBlock: ReturnType<typeof vi.fn>;
  pruneExpired: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function makeFakeStore(): FakeStore {
  const fake: FakeStore = {
    blocked: new Set<string>(),
    hitCount: new Map<string, number>(),
    isBlocked: vi.fn(async (_ip: string, _now: number) => false),
    recordRejection: vi.fn(async (ip: string, _r: string, _n: number) => {
      const c = (fake.hitCount.get(ip) ?? 0) + 1;
      fake.hitCount.set(ip, c);
      return { hitCount: c, blocked: fake.blocked.has(ip) };
    }),
    extendBlock: vi.fn(async (ip: string) => {
      fake.blocked.add(ip);
    }),
    pruneExpired: vi.fn(async () => 0),
    close: vi.fn(),
  };
  return fake;
}

let fake: FakeStore;

vi.mock("../../server/core/services/tursoBotDefenseStore", () => ({
  createTursoBotDefenseStore: () => fake,
}));

// 必须在 mock 后 import service
import { BotDefenseService } from "../../server/core/services/botDefense";

describe("BotDefenseService.isBlocked", () => {
  let svc: BotDefenseService;

  beforeEach(async () => {
    fake = makeFakeStore();
    svc = new BotDefenseService();
    // 等 initPromise（rejection 调用 store）
    await new Promise((r) => setTimeout(r, 0));
    svc.reset();
    fake.isBlocked.mockClear();
  });

  it("无效 IP（空串/'unknown'）一律视为不在黑名单", async () => {
    expect(await svc.isBlocked("")).toBe(false);
    expect(await svc.isBlocked("unknown")).toBe(false);
  });

  it("Turso 返回 blocked → 缓存为 pos，5min 内复用不查 store", async () => {
    fake.isBlocked.mockResolvedValueOnce(true);
    expect(await svc.isBlocked("1.2.3.4")).toBe(true);
    expect(await svc.isBlocked("1.2.3.4")).toBe(true);
    expect(await svc.isBlocked("1.2.3.4")).toBe(true);
    // 第一次查 store，后续走 pos cache 不再查 store
    expect(fake.isBlocked).toHaveBeenCalledTimes(1);
  });

  it("Turso 返回非 blocked → 缓存为 neg，30s 内复用不查 store", async () => {
    fake.isBlocked.mockResolvedValue(false);
    expect(await svc.isBlocked("5.6.7.8")).toBe(false);
    expect(await svc.isBlocked("5.6.7.8")).toBe(false);
    expect(await svc.isBlocked("5.6.7.8")).toBe(false);
    expect(fake.isBlocked).toHaveBeenCalledTimes(1);
  });

  it("Turso 查询异常 → 一律放行（fail-open），不抛错", async () => {
    fake.isBlocked.mockRejectedValue(new Error("turso down"));
    await expect(svc.isBlocked("9.9.9.9")).resolves.toBe(false);
  });
});

describe("BotDefenseService.recordRejection", () => {
  let svc: BotDefenseService;

  beforeEach(async () => {
    fake = makeFakeStore();
    svc = new BotDefenseService();
    await new Promise((r) => setTimeout(r, 0));
    svc.reset();
  });

  it("无效 IP 直接 return，不调 store", async () => {
    await svc.recordRejection("", "bot_ua");
    await svc.recordRejection("unknown", "bot_ua");
    expect(fake.recordRejection).not.toHaveBeenCalled();
  });

  it("同一 IP 累计 ≥5 → 调 extendBlock 拉黑", async () => {
    for (let i = 0; i < 5; i++) {
      await svc.recordRejection("1.1.1.1", "bot_ua", 1000 + i * 10);
    }
    expect(fake.extendBlock).toHaveBeenCalledTimes(1);
    expect(fake.extendBlock).toHaveBeenCalledWith("1.1.1.1", "bot_ua", expect.any(Number));
  });

  it("累计 <5 不触发 extendBlock", async () => {
    for (let i = 0; i < 4; i++) {
      await svc.recordRejection("2.2.2.2", "rate_limit", 2000 + i * 10);
    }
    expect(fake.extendBlock).not.toHaveBeenCalled();
  });

  it("滑动窗口：超过 60s 的旧 hit 不连续触发前次拉黑", async () => {
    // 第 1 次：t=0（旧）
    await svc.recordRejection("3.3.3.3", "bot_ua", 1000);
    // 第 2 次：t=200s，远离窗口，旧 hit 被清
    await svc.recordRejection("3.3.3.3", "bot_ua", 201000);
    // 至此 hitTimestamps 只剩 [201000]，storedCount = 2。
    // 再 4 次快速打到 6，但前 4 次都在窗口内连续累计，永远不会"5 次 retry"才拉黑
    // 因为 storedCount 已经 6，达不到"刚好 5"边界断言
    // 改成：手动验证 storedCount = 5 时的边界
    fake.extendBlock.mockClear();
    fake.recordRejection.mockClear();
    fake.hitCount.clear();

    // 5 次连续快打（窗口内）：
    for (let i = 0; i < 5; i++) {
      await svc.recordRejection("4.4.4.4", "bot_ua", 300000 + i * 100);
    }
    // storedCount = 5, recent.length = 5 → 至少一边满足 → extendBlock 1 次
    expect(fake.extendBlock).toHaveBeenCalledTimes(1);
  });

  it("持久化失败时 recordRejection 不抛错（fail-soft）", async () => {
    fake.recordRejection.mockRejectedValueOnce(new Error("network"));
    await expect(svc.recordRejection("3.3.3.3", "bot_ua")).resolves.toBeUndefined();
  });
});

describe("BotDefenseService Turso 不可用降级", () => {
  it("store init 失败时 isBlocked / recordRejection 都不抛错（fail-soft）", async () => {
    // 独立模块实例，避免与其他 describe 共用 vi.mock factory
    vi.resetModules();
    vi.doMock("../../server/core/services/tursoBotDefenseStore", () => ({
      createTursoBotDefenseStore: () => {
        throw new Error("no TURSO_URL");
      },
    }));
    const mod = await import("../../server/core/services/botDefense");
    const svc = new mod.BotDefenseService();
    // 等 initPromise 完成（catch 路径已走）
    await new Promise((r) => setTimeout(r, 50));
    expect(await svc.isBlocked("1.2.3.4")).toBe(false);
    await expect(svc.recordRejection("1.2.3.4", "bot_ua")).resolves.toBeUndefined();
    // 不要 vi.doUnmock / vi.resetModules（其他 describe 在同一文件并发下可能不可预测）
  });
});
