/**
 * adminOriginCheck（管理接口同源校验）单元测试
 *
 * 验证：
 * - 读接口：Origin 或 Referer 任一匹配白名单 → 放行；都不匹配 → 403
 * - 写接口：Origin+Referer 必须全部匹配 → 放行；任一不匹配 → 403；
 *   无来源 → 403（拒绝无来源后门）
 * - 内部探活旁路（x-admin-heartbeat）绕过所有校验
 * - ADMIN_ORIGIN_ALLOWLIST 环境变量扩展白名单
 * - ADMIN_FORCE_READ_ORIGIN=0 可关闭读接口校验
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { H3Event } from "h3";

// mock h3（只暴露用到的函数）
vi.mock("h3", () => ({
  getRequestHeader: vi.fn(),
  createError: vi.fn((opts: any) => ({ ...opts, __isH3Error: true })),
}));

import * as h3 from "h3";
import {
  requireAdminOrigin,
  isInternalHeartbeat,
} from "../../server/utils/adminOriginCheck";

const mockedGetRequestHeader = vi.mocked(h3.getRequestHeader);

function makeEvent(
  headers: Record<string, string> = {},
  method = "GET",
): H3Event {
  const event = {
    method,
    path: "/api/blacklist",
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as any;
  mockedGetRequestHeader.mockImplementation((e: any, name: string) =>
    headers[name.toLowerCase()] ?? null,
  );
  return event;
}

describe("同源校验：读接口（GET/HEAD）", () => {
  it("GET 带同源 Origin → 放行", () => {
    const event = makeEvent({ origin: "https://panhub.shenzjd.com" });
    expect(requireAdminOrigin(event)).toBe(true);
  });

  it("GET 带同源 Referer → 放行", () => {
    const event = makeEvent({ referer: "https://panhub.shenzjd.com/admin" });
    expect(requireAdminOrigin(event)).toBe(true);
  });

  it("GET 跨源 Origin → 403", () => {
    const event = makeEvent({ origin: "https://evil.example.com" });
    expect(() => requireAdminOrigin(event)).toThrow();
  });

  it("GET 无任何来源 → 403（默认强制）", () => {
    const event = makeEvent({});
    expect(() => requireAdminOrigin(event)).toThrow();
  });

  it("ADMIN_FORCE_READ_ORIGIN=0 关闭读校验 → 无来源放行", () => {
    process.env.ADMIN_FORCE_READ_ORIGIN = "0";
    const event = makeEvent({});
    expect(requireAdminOrigin(event)).toBe(true);
  });
});

describe("同源校验：写接口（POST/DELETE）", () => {
  it("POST 同源 Origin+Referer → 放行", () => {
    const event = makeEvent(
      {
        origin: "https://panhub.shenzjd.com",
        referer: "https://panhub.shenzjd.com/admin",
      },
      "POST",
    );
    expect(requireAdminOrigin(event)).toBe(true);
  });

  it("POST 仅 Referer 同源（无 Origin） → 放行", () => {
    const event = makeEvent(
      { referer: "https://panhub.shenzjd.com/admin" },
      "POST",
    );
    expect(requireAdminOrigin(event)).toBe(true);
  });

  it("DELETE 跨源 → 403", () => {
    const event = makeEvent(
      { origin: "https://evil.example.com" },
      "DELETE",
    );
    expect(() => requireAdminOrigin(event)).toThrow();
  });

  it("POST 无来源 → 403（不设无来源后门）", () => {
    const event = makeEvent({}, "POST");
    expect(() => requireAdminOrigin(event)).toThrow();
  });

  it("POST 来源混合（Origin 同源 / Referer 跨源）→ 403", () => {
    const event = makeEvent(
      {
        origin: "https://panhub.shenzjd.com",
        referer: "https://evil.example.com/x",
      },
      "POST",
    );
    expect(() => requireAdminOrigin(event)).toThrow();
  });
});

describe("白名单与环境变量", () => {
  const OLD = process.env.ADMIN_ORIGIN_ALLOWLIST;
  afterEach(() => {
    if (OLD === undefined) delete process.env.ADMIN_ORIGIN_ALLOWLIST;
    else process.env.ADMIN_ORIGIN_ALLOWLIST = OLD;
  });

  it("ADMIN_ORIGIN_ALLOWLIST 扩展白名单（含 CN 回源域名）", () => {
    process.env.ADMIN_ORIGIN_ALLOWLIST =
      "panhub-shenzjd-com.shenzjd.workers.dev, panhub1.shenzjd.com";
    const event = makeEvent(
      { origin: "https://panhub-shenzjd-com.shenzjd.workers.dev" },
      "POST",
    );
    expect(requireAdminOrigin(event)).toBe(true);
  });

  it("端口会被剥离（localhost:3000 归属 localhost）", () => {
    process.env.ADMIN_ORIGIN_ALLOWLIST = "localhost";
    const event = makeEvent(
      { origin: "https://localhost:3000" },
      "POST",
    );
    expect(requireAdminOrigin(event)).toBe(true);
  });
});

describe("内部探活旁路", () => {
  it("x-admin-heartbeat=1 → 直接放行（跳过校验）", () => {
    const event = makeEvent(
      { "x-admin-heartbeat": "1" },
      "POST",
    );
    expect(requireAdminOrigin(event)).toBe(true);
    expect(isInternalHeartbeat(event)).toBe(true);
  });
});