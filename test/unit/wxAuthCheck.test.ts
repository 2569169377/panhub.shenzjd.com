/**
 * wxAuthCheck（微信关注公众号登录态校验）单元测试
 *
 * 验证：
 * - 开关控制（WX_AUTH_ENFORCE 未开启不启用）
 * - cookie 提取（token 优先，openid 兜底，无 cookie 返回空）
 * - 实时校验：check 返回 authenticated=true → 放行；false → 拒绝
 * - 无 cookie → false（拒绝）
 * - wx-auth 服务故障/非 2xx → 降级放行（不误伤真人）
 * - 请求内去重：同一次请求只调一次远程
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { H3Event } from "h3";

// mock h3
vi.mock("h3", () => ({
  getCookie: vi.fn(),
  createError: vi.fn((opts: any) => ({ ...opts, __isH3Error: true })),
  getHeader: vi.fn(),
  getRequestHeader: vi.fn(),
}));

import * as h3 from "h3";
import {
  isWxAuthEnforced,
  getWxAuthCredential,
  verifyWxAuthCredential,
  verifyWxAuthOnce,
  verifyWxAuthOnceCached,
  resetWxAuthCache,
} from "../../server/utils/wxAuthCheck";

const mockedGetCookie = vi.mocked(h3.getCookie);

function makeEvent(cookies: Record<string, string> = {}): H3Event {
  const event = { context: {}, headers: { get: () => undefined } } as any;
  mockedGetCookie.mockImplementation((e: any, name: string) => cookies[name]);
  return event;
}

describe("isWxAuthEnforced", () => {
  const OLD = process.env.WX_AUTH_ENFORCE;
  afterEach(() => {
    if (OLD === undefined) delete process.env.WX_AUTH_ENFORCE;
    else process.env.WX_AUTH_ENFORCE = OLD;
  });

  it("未设置时默认关闭", () => {
    delete process.env.WX_AUTH_ENFORCE;
    expect(isWxAuthEnforced()).toBe(false);
  });

  it("WX_AUTH_ENFORCE=1 时启用", () => {
    process.env.WX_AUTH_ENFORCE = "1";
    expect(isWxAuthEnforced()).toBe(true);
  });

  it("WX_AUTH_ENFORCE=0 时关闭", () => {
    process.env.WX_AUTH_ENFORCE = "0";
    expect(isWxAuthEnforced()).toBe(false);
  });
});

describe("getWxAuthCredential", () => {
  beforeEach(() => mockedGetCookie.mockReset());

  it("token 优先", () => {
    const event = makeEvent({ "wxauth-token": "tok123", "wxauth-openid": "oid456" });
    expect(getWxAuthCredential(event)).toEqual({ token: "tok123" });
  });

  it("无 token 时 openid 兜底", () => {
    const event = makeEvent({ "wxauth-openid": "oid456" });
    expect(getWxAuthCredential(event)).toEqual({ openid: "oid456" });
  });

  it("无 cookie 返回空对象", () => {
    const event = makeEvent({});
    expect(getWxAuthCredential(event)).toEqual({});
  });
});

describe("verifyWxAuthCredential", () => {
  const OLD_BASE = process.env.WX_AUTH_API_BASE;
  const OLD_ENFORCE = process.env.WX_AUTH_ENFORCE;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.WX_AUTH_API_BASE = "https://wx-auth.example.com";
    process.env.WX_AUTH_ENFORCE = "1";
    fetchMock = vi.fn();
    (globalThis as any).fetch = fetchMock;
    mockedGetCookie.mockReset();
  });

  afterEach(() => {
    if (OLD_BASE === undefined) delete process.env.WX_AUTH_API_BASE;
    else process.env.WX_AUTH_API_BASE = OLD_BASE;
    if (OLD_ENFORCE === undefined) delete process.env.WX_AUTH_ENFORCE;
    else process.env.WX_AUTH_ENFORCE = OLD_ENFORCE;
  });

  it("check 返回 authenticated:true → 放行", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ authenticated: true }) });
    const event = makeEvent({ "wxauth-token": "valid-token" });
    expect(await verifyWxAuthCredential(event)).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/auth/check?token=valid-token"),
      expect.anything()
    );
  });

  it("check 返回 authenticated:false → 拒绝", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ authenticated: false }) });
    const event = makeEvent({ "wxauth-token": "invalid-token" });
    expect(await verifyWxAuthCredential(event)).toBe(false);
  });

  it("无 cookie → 拒绝且不调远程", async () => {
    const event = makeEvent({});
    expect(await verifyWxAuthCredential(event)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("check 非 2xx → 降级放行", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const event = makeEvent({ "wxauth-token": "tok" });
    expect(await verifyWxAuthCredential(event)).toBe(true);
  });

  it("网络错误/超时 → 降级放行", async () => {
    fetchMock.mockRejectedValue(new Error("timeout"));
    const event = makeEvent({ "wxauth-token": "tok" });
    expect(await verifyWxAuthCredential(event)).toBe(true);
  });

  it("openid 兜底路径", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ authenticated: true }) });
    const event = makeEvent({ "wxauth-openid": "oid" });
    expect(await verifyWxAuthCredential(event)).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/auth/check?openid=oid"),
      expect.anything()
    );
  });
});

describe("verifyWxAuthOnce（请求内去重）", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.WX_AUTH_API_BASE = "https://wx-auth.example.com";
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ authenticated: true }) });
    (globalThis as any).fetch = fetchMock;
    mockedGetCookie.mockReset();
  });

  it("同一次请求内多次调用只调一次远程", async () => {
    const event = makeEvent({ "wxauth-token": "tok" });
    expect(await verifyWxAuthOnce(event)).toBe(true);
    expect(await verifyWxAuthOnce(event)).toBe(true);
    expect(await verifyWxAuthOnce(event)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("verifyWxAuthOnceCached（跨请求短 TTL 去重，2026-08-24）", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.WX_AUTH_API_BASE = "https://wx-auth.example.com";
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ authenticated: true }) });
    (globalThis as any).fetch = fetchMock;
    mockedGetCookie.mockReset();
    resetWxAuthCache();
  });

  it("同一 token 跨多个请求（如一次搜索 35+ 子请求）只调一次远程", async () => {
    // 模拟一次搜索的 40 个并发子请求（各自独立 event，同 cookie）
    for (let i = 0; i < 40; i++) {
      const event = makeEvent({ "wxauth-token": "shared-token" });
      expect(await verifyWxAuthOnceCached(event)).toBe(true);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("不同 token 各自独立校验", async () => {
    await verifyWxAuthOnceCached(makeEvent({ "wxauth-token": "t1" }));
    await verifyWxAuthOnceCached(makeEvent({ "wxauth-token": "t2" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("false 结果也缓存（10s 内同一 token 反复失败不重复打远程）", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ authenticated: false }) });
    for (let i = 0; i < 10; i++) {
      const event = makeEvent({ "wxauth-token": "bad-token" });
      expect(await verifyWxAuthOnceCached(event)).toBe(false);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("无 cookie 不缓存不调远程（直接拒绝）", async () => {
    expect(await verifyWxAuthOnceCached(makeEvent({}))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
