import { describe, it, expect } from "vitest";
import { PanyqPlugin } from "../../server/core/plugins/panyq";
import { Fox4kPlugin } from "../../server/core/plugins/fox4k";
import { SusuPlugin } from "../../server/core/plugins/susu";
import { Pan666Plugin } from "../../server/core/plugins/pan666";

describe("2026-08-07 盘点新增插件（混合网盘型）", () => {
  it("panyq 构造正常", () => {
    const p = new PanyqPlugin();
    expect(p.name()).toBe("panyq");
  });

  it("fox4k 构造正常", () => {
    const p = new Fox4kPlugin();
    expect(p.name()).toBe("fox4k");
  });

  it("susu 构造正常", () => {
    const p = new SusuPlugin();
    expect(p.name()).toBe("susu");
  });

  it("pan666 构造正常", () => {
    const p = new Pan666Plugin();
    expect(p.name()).toBe("pan666");
  });
});
