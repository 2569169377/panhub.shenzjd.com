/**
 * requireAuth（requireHumanOrCredential / requireWxAuth）单元测试
 *
 * 验证（2026-08-28 更新：Bearer 改为校验 token，删除 client-secret）：
 * - bot/脚本 UA 无凭证 → 403（入口拦截，不执行搜索）
 * - bot/脚本 UA 带 Bearer → 放行（有效性由 requireWxAuth 校验）
 * - 正常浏览器 UA → 放行
 * - requireWxAuth：
 *   - 无 Bearer：恒强制——未关注公众号 → 401；校验通过放行
 *   - 有 Bearer：校验 token 有效性——有效放行，无效 401
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { isBotUA } from "../../utils/botUA";

// mock h3：requireAuth 只用到这几个函数
vi.mock("h3", () => ({
  createError: vi.fn((opts: any) => ({ ...opts, __isH3Error: true })),
  getHeader: vi.fn(),
  getRequestHeader: vi.fn(),
}));

// mock wxAuthCheck：避免测试触发远程 HTTP
vi.mock("../../server/utils/wxAuthCheck", () => ({
  verifyWxAuthOnceCached: vi.fn(async () => true),
}));

// mock mpToken：verifyMpBearerToken 可控
vi.mock("../../server/utils/mpToken", () => ({
  verifyMpBearerToken: vi.fn(async () => ({ valid: false })),
  getMpTokenStore: vi.fn(() => null),
}));

// mock rateLimiter：避免加载 h3 defineEventHandler（getClientIp 供 requireAuth 日志用）
vi.mock("../../server/middleware/rateLimiter", () => ({
  getClientIp: vi.fn(() => "127.0.0.1"),
}));

// mock botDefense（requireAuth 里 recordRejection 异步调用）
vi.mock("../../server/core/services/botDefense", () => ({
  getOrCreateBotDefenseService: () => ({
    recordRejection: vi.fn(async () => ({})),
    isBlocked: vi.fn(async () => false),
  }),
}));

import { requireHumanOrCredential, requireWxAuth } from "../../server/utils/requireAuth";
import * as h3 from "h3";
import * as wxAuthCheck from "../../server/utils/wxAuthCheck";
import * as mpToken from "../../server/utils/mpToken";

const mockedVerifyWxAuthOnce = vi.mocked(wxAuthCheck.verifyWxAuthOnceCached);
const mockedVerifyMpBearer = vi.mocked(mpToken.verifyMpBearerToken);

const mockedGetHeader = vi.mocked(h3.getHeader);
const mockedGetRequestHeader = vi.mocked(h3.getRequestHeader);

function makeEvent(headers: Record<string, string | undefined> = {}) {
  return {
    headers: { get: (k: string) => headers[k.toLowerCase()] },
    context: {} as Record<string, any>,
  } as any;
}

function expectH3Error(fn: () => void, statusCode: number) {
  let err: any;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeDefined();
  expect(err.__isH3Error).toBe(true);
  expect(err.statusCode).toBe(statusCode);
}

async function expectH3ErrorAsync(
  fn: () => Promise<void>,
  statusCode: number
) {
  let err: any;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeDefined();
  expect(err.__isH3Error).toBe(true);
  expect(err.statusCode).toBe(statusCode);
}

describe("requireHumanOrCredential", () => {
  beforeEach(() => {
    mockedGetHeader.mockReset();
    mockedGetRequestHeader.mockReset();
  });

  it("正常浏览器 UA 放行", () => {
    mockedGetHeader.mockReturnValue(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    );
    mockedGetRequestHeader.mockReturnValue(undefined);
    expect(() => requireHumanOrCredential(makeEvent())).not.toThrow();
  });

  it("无 UA 放行（小程序等真实渠道兜底）", () => {
    mockedGetHeader.mockReturnValue(undefined);
    mockedGetRequestHeader.mockReturnValue(undefined);
    expect(() => requireHumanOrCredential(makeEvent())).not.toThrow();
  });

  it("curl UA 无凭证 → 403", () => {
    mockedGetHeader.mockReturnValue("curl/8.7.1");
    mockedGetRequestHeader.mockReturnValue(undefined);
    expectH3Error(() => requireHumanOrCredential(makeEvent()), 403);
  });

  it("python-requests UA 无凭证 → 403", () => {
    mockedGetHeader.mockReturnValue("python-requests/2.31.0");
    mockedGetRequestHeader.mockReturnValue(undefined);
    expectH3Error(() => requireHumanOrCredential(makeEvent()), 403);
  });

  it("Googlebot UA 无凭证 → 403（sitemap 自举拦截）", () => {
    mockedGetHeader.mockReturnValue(
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"
    );
    mockedGetRequestHeader.mockReturnValue(undefined);
    expectH3Error(() => requireHumanOrCredential(makeEvent()), 403);
  });

  it("bot UA 带 Bearer token → 放行（有效性留给 requireWxAuth 校验）", () => {
    mockedGetHeader.mockReturnValue("curl/8.7.1");
    mockedGetRequestHeader.mockImplementation((e: any, name: string) =>
      name.toLowerCase() === "authorization" ? "Bearer abc123" : undefined
    );
    expect(() => requireHumanOrCredential(makeEvent())).not.toThrow();
  });

  it("bot UA 不再放行 x-panhub-client-secret（2026-08-28 删除）→ 403", () => {
    mockedGetHeader.mockReturnValue("okhttp/4.12.0");
    mockedGetRequestHeader.mockImplementation((e: any, name: string) =>
      name.toLowerCase() === "x-panhub-client-secret" ? "mp-secret" : undefined
    );
    expectH3Error(() => requireHumanOrCredential(makeEvent()), 403);
  });
});

// 确保 isBotUA 兜底可用（引用不报错）
describe("isBotUA（依赖引用完整性）", () => {
  it("可正常判定", () => {
    expect(isBotUA("curl/8.7.1")).toBe(true);
    expect(isBotUA("Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36")).toBe(false);
  });
});

describe("requireWxAuth", () => {
  beforeEach(() => {
    mockedVerifyWxAuthOnce.mockReset();
    mockedVerifyMpBearer.mockReset();
    mockedGetHeader.mockReset();
    mockedGetRequestHeader.mockReset();
  });

  it("有效 Bearer token → 放行（小程序）", async () => {
    mockedGetRequestHeader.mockImplementation((e: any, name: string) =>
      name.toLowerCase() === "authorization" ? "Bearer abc" : undefined
    );
    mockedVerifyMpBearer.mockResolvedValue({ valid: true, openid: "mp-openid-1" });
    await expect(requireWxAuth(makeEvent())).resolves.toBeUndefined();
    expect(mockedVerifyMpBearer).toHaveBeenCalled();
    expect(mockedVerifyWxAuthOnce).not.toHaveBeenCalled();
  });

  it("无效 Bearer token → 401（不降级走公众号校验）", async () => {
    mockedGetRequestHeader.mockImplementation((e: any, name: string) =>
      name.toLowerCase() === "authorization" ? "Bearer invalid" : undefined
    );
    mockedVerifyMpBearer.mockResolvedValue({ valid: false });
    await expectH3ErrorAsync(() => requireWxAuth(makeEvent()), 401);
    expect(mockedVerifyMpBearer).toHaveBeenCalled();
    expect(mockedVerifyWxAuthOnce).not.toHaveBeenCalled();
  });

  it("无 Bearer：恒强制——未关注公众号 → 401", async () => {
    mockedVerifyWxAuthOnce.mockResolvedValue(false);
    mockedGetRequestHeader.mockReturnValue(undefined);
    await expectH3ErrorAsync(() => requireWxAuth(makeEvent()), 401);
    expect(mockedVerifyWxAuthOnce).toHaveBeenCalled();
  });

  it("无 Bearer：校验通过 → 放行", async () => {
    mockedVerifyWxAuthOnce.mockResolvedValue(true);
    mockedGetRequestHeader.mockReturnValue(undefined);
    await expect(requireWxAuth(makeEvent())).resolves.toBeUndefined();
  });

  it("不再放行 x-panhub-client-secret（2026-08-28 删除）→ 走公众号校验", async () => {
    mockedVerifyWxAuthOnce.mockResolvedValue(false);
    mockedGetRequestHeader.mockImplementation((e: any, name: string) =>
      name.toLowerCase() === "x-panhub-client-secret" ? "secret" : undefined
    );
    await expectH3ErrorAsync(() => requireWxAuth(makeEvent()), 401);
    expect(mockedVerifyMpBearer).not.toHaveBeenCalled();
    expect(mockedVerifyWxAuthOnce).toHaveBeenCalled();
  });
});
