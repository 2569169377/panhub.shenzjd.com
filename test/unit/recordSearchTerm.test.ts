/**
 * recordSearchTerm 单元测试
 *
 * 2026-08-22 策略：只要搜索就记录 + 打印日志（防刷前移到搜索入口，
 * 本层不再做 UA/IP 过滤）。
 *
 * 验证：
 * - 正常词记录
 * - 非法词条跳过（空串/超长/URL/特殊字符）
 * - 记录失败静默不影响主流程
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { recordSearchTerm } from "../../server/utils/recordSearchTerm";

// mock 热搜服务，避免测试触碰 Turso（返回单例，模拟真实 getOrCreate 语义）
const mockService = {
  recordSearch: vi.fn().mockResolvedValue(undefined),
};
vi.mock("../../server/core/services/hotSearchService", () => ({
  getOrCreateHotSearchService: vi.fn(() => mockService),
}));

import { getOrCreateHotSearchService } from "../../server/core/services/hotSearchService";

const mockedGetService = vi.mocked(getOrCreateHotSearchService);

describe("recordSearchTerm", () => {
  beforeEach(() => {
    mockedGetService.mockClear();
    mockService.recordSearch.mockClear();
  });

  it("正常中文词记录", async () => {
    await recordSearchTerm("凡人修仙传");
    expect(mockedGetService).toHaveBeenCalledTimes(1);
    expect(mockService.recordSearch).toHaveBeenCalledWith("凡人修仙传");
  });

  it("带空格/英文/数字的词记录（trim 后）", async () => {
    await recordSearchTerm("  肖申克的救赎  ");
    await recordSearchTerm("test123 abc");
    expect(mockService.recordSearch).toHaveBeenCalledTimes(2);
    expect(mockService.recordSearch).toHaveBeenNthCalledWith(1, "肖申克的救赎");
    expect(mockService.recordSearch).toHaveBeenNthCalledWith(2, "test123 abc");
  });

  it("非法词条不记录（空串/纯空白/超长/URL/特殊字符）", async () => {
    await recordSearchTerm("");
    await recordSearchTerm("   ");
    await recordSearchTerm("a".repeat(51));
    await recordSearchTerm("https://example.com");
    await recordSearchTerm("2024年-最新款!");
    await recordSearchTerm("test+abc");
    expect(mockedGetService).not.toHaveBeenCalled();
  });

  it("记录失败静默（不影响主流程，不抛错）", async () => {
    mockedGetService.mockImplementationOnce(() => {
      throw new Error("store unavailable");
    });
    await expect(recordSearchTerm("凡人修仙传")).resolves.toBeUndefined();
  });
});
