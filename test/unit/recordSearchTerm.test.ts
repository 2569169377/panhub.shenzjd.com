/**
 * recordSearchTerm / isBotUA / IP 节流 单元测试
 *
 * 验证：
 * - 爬虫/脚本 UA 命中时跳过热搜记录（切断 sitemap 自举循环与外部刷词）
 * - 正常浏览器 UA / 无 UA 正常记录
 * - 同 IP 窗口超量丢弃（抗脚本换 UA 刷词底线）
 * - 词条格式校验（非法词不记录）
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { isBotUA } from "../../utils/botUA";
import { recordSearchTerm, isThrottledByIp, resetIpThrottle } from "../../server/utils/recordSearchTerm";

// mock 热搜服务，避免测试触碰 Turso
vi.mock("../../server/core/services/hotSearchService", () => ({
  getOrCreateHotSearchService: vi.fn(() => ({
    recordSearch: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { getOrCreateHotSearchService } from "../../server/core/services/hotSearchService";

const mockedGetService = vi.mocked(getOrCreateHotSearchService);

describe("isBotUA（共享 utils）", () => {
  it("识别主流搜索引擎爬虫", () => {
    expect(isBotUA("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toBe(true);
    expect(isBotUA("Baiduspider/2.0; +http://www.baidu.com/search/spider.html")).toBe(true);
    expect(isBotUA("Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)")).toBe(true);
    expect(isBotUA("Sogou web spider/4.0(+http://www.sogou.com/docs/help/webmasters.htm#07)")).toBe(true);
    expect(isBotUA("360Spider (compatible; HaosouSpider; +http://www.haosou.com/help/help_3_2.html)")).toBe(true);
    expect(isBotUA("Bytespider (compatible; Bytespider; +https://www.bytedance.com/robots)")).toBe(true);
    expect(isBotUA("Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)")).toBe(true);
    expect(isBotUA("Mozilla/5.0 (compatible; PetalBot;+https://www.huaweicloud.com/product/petalbot.html)")).toBe(true);
    expect(isBotUA("SemrushBot/7~bl; +http://www.semrush.com/bot.html")).toBe(true);
    expect(isBotUA("Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)")).toBe(true);
    expect(isBotUA("Mozilla/5.0 (compatible; MJ12bot/v1.4.8; http://mj12bot.com/)")).toBe(true);
    expect(isBotUA("DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)")).toBe(true);
    expect(isBotUA("facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)")).toBe(true);
    expect(isBotUA("Twitterbot/1.0")).toBe(true);
  });

  it("识别脚本/HTTP 客户端 UA", () => {
    expect(isBotUA("curl/8.7.1")).toBe(true);
    expect(isBotUA("Wget/1.21.3")).toBe(true);
    expect(isBotUA("python-requests/2.31.0")).toBe(true);
    expect(isBotUA("node-fetch/1.0 (+https://github.com/bitinn/node-fetch)")).toBe(true);
    expect(isBotUA("axios/1.6.0")).toBe(true);
    expect(isBotUA("Go-http-client/1.1")).toBe(true);
    expect(isBotUA("PostmanRuntime/7.36.0")).toBe(true);
    expect(isBotUA("okhttp/4.12.0")).toBe(true);
  });

  it("正常浏览器 UA 不判定为爬虫", () => {
    expect(isBotUA("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")).toBe(false);
    expect(isBotUA("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")).toBe(false);
    expect(isBotUA("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0")).toBe(false);
  });

  it("空 UA 不判定为爬虫（保留小程序等真实渠道）", () => {
    expect(isBotUA(undefined)).toBe(false);
    expect(isBotUA(null)).toBe(false);
    expect(isBotUA("")).toBe(false);
  });
});

describe("isThrottledByIp", () => {
  beforeEach(() => {
    resetIpThrottle();
  });

  it("窗口内前 20 条放行，超出丢弃", () => {
    for (let i = 1; i <= 20; i++) {
      expect(isThrottledByIp("1.2.3.4")).toBe(false);
    }
    expect(isThrottledByIp("1.2.3.4")).toBe(true);
    expect(isThrottledByIp("1.2.3.4")).toBe(true);
  });

  it("不同 IP 独立计数", () => {
    for (let i = 0; i < 30; i++) isThrottledByIp("5.6.7.8");
    expect(isThrottledByIp("9.9.9.9")).toBe(false);
    expect(isThrottledByIp("9.9.9.9")).toBe(false);
  });

  it("无 IP 放行", () => {
    expect(isThrottledByIp(undefined)).toBe(false);
    expect(isThrottledByIp(null)).toBe(false);
  });
});

describe("recordSearchTerm", () => {
  beforeEach(() => {
    mockedGetService.mockClear();
    resetIpThrottle();
  });

  it("正常浏览器 UA 记录搜索词", async () => {
    await recordSearchTerm("凡人修仙传", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36");
    expect(mockedGetService).toHaveBeenCalledTimes(1);
    const svc = mockedGetService.mock.results[0].value;
    expect(svc.recordSearch).toHaveBeenCalledWith("凡人修仙传");
  });

  it("爬虫 UA 跳过记录", async () => {
    await recordSearchTerm("凡人修仙传", "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)");
    expect(mockedGetService).not.toHaveBeenCalled();
  });

  it("脚本 UA 跳过记录（curl）", async () => {
    await recordSearchTerm("凡人修仙传", "curl/8.7.1");
    expect(mockedGetService).not.toHaveBeenCalled();
  });

  it("无 UA 仍记录（真实渠道兜底）", async () => {
    await recordSearchTerm("凡人修仙传", undefined);
    expect(mockedGetService).toHaveBeenCalledTimes(1);
  });

  it("同 IP 超量后跳过记录（抗刷底线）", async () => {
    for (let i = 0; i < 20; i++) {
      await recordSearchTerm(`词${i}`, "Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36", "203.0.113.7");
    }
    expect(mockedGetService).toHaveBeenCalledTimes(20);
    // 第 21 条同 IP 被节流丢弃
    await recordSearchTerm("超量词", "Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36", "203.0.113.7");
    expect(mockedGetService).toHaveBeenCalledTimes(20);
  });

  it("节流不影响其他 IP 的记录", async () => {
    for (let i = 0; i < 25; i++) {
      await recordSearchTerm(`刷词${i}`, "Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36", "198.51.100.9");
    }
    expect(mockedGetService).toHaveBeenCalledTimes(20);
    await recordSearchTerm("正常用户", "Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36", "198.51.100.10");
    expect(mockedGetService).toHaveBeenCalledTimes(21);
  });

  it("非法词条不记录（空串/超长/特殊字符）", async () => {
    await recordSearchTerm("", "Mozilla/5.0");
    await recordSearchTerm("  ", "Mozilla/5.0");
    await recordSearchTerm("a".repeat(51), "Mozilla/5.0");
    await recordSearchTerm("https://example.com", "Mozilla/5.0");
    expect(mockedGetService).not.toHaveBeenCalled();
  });
});
