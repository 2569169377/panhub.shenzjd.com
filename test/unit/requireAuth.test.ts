/**
 * requireAuth（requireSearchAuth / requireHumanOrCredential / requireWxAuth）单元测试
 *
 * 验证：
 * - 密码门未配置时 requireSearchAuth 放行
 * - 密码门配置后未解锁抛 401
 * - bot/脚本 UA 无凭证 → 403（入口拦截，不执行搜索）
 * - bot/脚本 UA 带 Bearer / client-secret → 放行（小程序等真实渠道）
 * - 正常浏览器 UA → 放行
 * - requireWxAuth：开关关闭跳过；开关开启时未认证 401；已带凭证放行
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { isBotUA } from "../../utils/botUA";

// mock h3：requireAuth 只用到这几个函数
vi.mock("h3", () => ({
  createError: vi.fn((opts: any) => ({ ...opts, __isH3Error: true })),
  getHeader: vi.fn(),
  getRequestHeader: vi.fn(),
}));

// mock auth：requireSearchAuth 依赖 isUnlocked（路径需与 requireAuth 内 import 解析到同一文件）
vi.mock("../../server/utils/auth", () => ({
  isUnlocked: vi.fn(() => false),
}));

// mock wxAuthCheck：避免测试触发远程 HTTP
vi.mock("../../server/utils/wxAuthCheck", () => ({
  isWxAuthEnforced: vi.fn(() => false),
  verifyWxAuthOnce: vi.fn(async () => true),
}));

// mock rateLimiter：避免加载 h3 defineEventHandler（getClientIp 供 requireAuth 日志用）
vi.mock("../../server/middleware/rateLimiter", () => ({
  getClientIp: vi.fn(() => "127.0.0.1"),
}));

import { requireSearchAuth, requireHumanOrCredential, requireWxAuth } from "../../server/utils/requireAuth";
import * as h3 from "h3";
import * as auth from "../../server/utils/auth";
import * as wxAuthCheck from "../../server/utils/wxAuthCheck";

const mockedIsWxAuthEnforced = vi.mocked(wxAuthCheck.isWxAuthEnforced);
const mockedVerifyWxAuthOnce = vi.mocked(wxAuthCheck.verifyWxAuthOnce);

const mockedGetHeader = vi.mocked(h3.getHeader);
const mockedGetRequestHeader = vi.mocked(h3.getRequestHeader);
// isUnlocked 是 vi.fn，直接拿引用设置返回值
const mockedIsUnlocked = auth.isUnlocked as unknown as ReturnType<typeof vi.fn>;

// 模拟 useRuntimeConfig（Nuxt 全局）
(globalThis as any).useRuntimeConfig = () => ({ searchPassword: "" });

function makeEvent(headers: Record<string, string | undefined> = {}) {
  return { headers: { get: (k: string) => headers[k.toLowerCase()] } } as any;
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

describe("requireSearchAuth", () => {
  beforeEach(() => {
    mockedIsUnlocked.mockReset();
  });

  it("密码门未配置时直接放行", () => {
    (globalThis as any).useRuntimeConfig = () => ({ searchPassword: "" });
    expect(() => requireSearchAuth(makeEvent())).not.toThrow();
  });

  it("密码门配置且已解锁时放行", () => {
    (globalThis as any).useRuntimeConfig = () => ({ searchPassword: "secret" });
    mockedIsUnlocked.mockReturnValue(true);
    expect(() => requireSearchAuth(makeEvent())).not.toThrow();
    expect(mockedIsUnlocked).toHaveBeenCalled();
  });

  it("密码门配置但未解锁时抛 401", () => {
    (globalThis as any).useRuntimeConfig = () => ({ searchPassword: "secret" });
    mockedIsUnlocked.mockReturnValue(false);
    expectH3Error(() => requireSearchAuth(makeEvent()), 401);
  });
});

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
    mockedGetHeader.mockReturnValue("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)");
    mockedGetRequestHeader.mockReturnValue(undefined);
    expectH3Error(() => requireHumanOrCredential(makeEvent()), 403);
  });

  it("bot UA 带 Bearer token → 放行（小程序）", () => {
    mockedGetHeader.mockReturnValue("curl/8.7.1");
    mockedGetRequestHeader.mockImplementation((e: any, name: string) =>
      name.toLowerCase() === "authorization" ? "Bearer abc123" : undefined
    );
    expect(() => requireHumanOrCredential(makeEvent())).not.toThrow();
  });

  it("bot UA 带 x-panhub-client-secret → 放行（小程序）", () => {
    mockedGetHeader.mockReturnValue("okhttp/4.12.0");
    mockedGetRequestHeader.mockImplementation((e: any, name: string) =>
      name.toLowerCase() === "x-panhub-client-secret" ? "mp-secret" : undefined
    );
    expect(() => requireHumanOrCredential(makeEvent())).not.toThrow();
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
    mockedIsWxAuthEnforced.mockReset();
    mockedVerifyWxAuthOnce.mockReset();
    mockedGetHeader.mockReset();
    mockedGetRequestHeader.mockReset();
  });

  it("开关未启用时跳过（不校验）", async () => {
    mockedIsWxAuthEnforced.mockReturnValue(false);
    expect(() => requireWxAuth(makeEvent())).not.toThrow();
    expect(mockedVerifyWxAuthOnce).not.toHaveBeenCalled();
  });

  it("开关启用且已带 Bearer 凭证 → 放行（小程序）", async () => {
    mockedIsWxAuthEnforced.mockReturnValue(true);
    mockedGetRequestHeader.mockImplementation((e: any, name: string) =>
      name.toLowerCase() === "authorization" ? "Bearer abc" : undefined
    );
    await expect(requireWxAuth(makeEvent())).resolves.toBeUndefined();
    expect(mockedVerifyWxAuthOnce).not.toHaveBeenCalled();
  });

  it("开关启用且已带 client-secret → 放行（小程序）", async () => {
    mockedIsWxAuthEnforced.mockReturnValue(true);
    mockedGetRequestHeader.mockImplementation((e: any, name: string) =>
      name.toLowerCase() === "x-panhub-client-secret" ? "secret" : undefined
    );
    await expect(requireWxAuth(makeEvent())).resolves.toBeUndefined();
    expect(mockedVerifyWxAuthOnce).not.toHaveBeenCalled();
  });

  it("开关启用、无凭证且未关注公众号 → 401", async () => {
    mockedIsWxAuthEnforced.mockReturnValue(true);
    mockedVerifyWxAuthOnce.mockResolvedValue(false);
    let err: any;
    try {
      await requireWxAuth(makeEvent());
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.__isH3Error).toBe(true);
    expect(err.statusCode).toBe(401);
    expect(mockedVerifyWxAuthOnce).toHaveBeenCalled();
  });

  it("开关启用、校验通过 → 放行", async () => {
    mockedIsWxAuthEnforced.mockReturnValue(true);
    mockedVerifyWxAuthOnce.mockResolvedValue(true);
    await expect(requireWxAuth(makeEvent())).resolves.toBeUndefined();
  });
});
