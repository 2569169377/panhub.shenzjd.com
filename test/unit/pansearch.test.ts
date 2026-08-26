import { describe, it, expect } from "vitest";
import { extractTitle } from "../../server/core/plugins/pansearch";

describe("pansearch.extractTitle", () => {
  it("上游用 <span class='highlight-keyword'> 包裹命中词时，提取完整标题而非孤立 [（2026-08-26 用户截图回归）", () => {
    const content =
      "名称：[<span class='highlight-keyword'>阿甘正传</span>][1994][励志][美国] 链接：https://pan.baidu.com/s/xxx";
    const title = extractTitle(content, "阿甘正传");
    expect(title).toContain("阿甘正传");
    expect(title).not.toBe("[");
    expect(/^[\[\]《》【】\s]+$/.test(title)).toBe(false);
  });

  it("名称：后紧跟 <span> 的变体也不截断成孤立《", () => {
    const content =
      "名称：《<span class='highlight-keyword'>繁花</span>》全集高清 百度网盘 https://pan.baidu.com/s/yyy";
    const title = extractTitle(content, "繁花");
    expect(title).toContain("繁花");
    expect(/^[\[\]《》【】\s]+$/.test(title)).toBe(false);
  });

  it("content 无「名称：」字段时回退用搜索关键词", () => {
    const content = "<p>随便一段没有名称字段的内容 https://pan.baidu.com/s/zzz</p>";
    const title = extractTitle(content, "阿甘正传");
    expect(title).toBe("阿甘正传");
  });

  it("英文冒号「名称:」也能提取", () => {
    const content =
      "名称:[<span class='highlight-keyword'>泰坦尼克号</span>]1997 4K https://pan.baidu.com/s/www";
    const title = extractTitle(content, "泰坦尼克号");
    expect(title).toContain("泰坦尼克号");
  });

  it("普通无标签 content 正常提取", () => {
    const content = "名称：肖申克的救赎 1994 1080P https://pan.baidu.com/s/aaa";
    const title = extractTitle(content, "肖申克的救赎");
    expect(title).toBe("肖申克的救赎 1994 1080P https://pan.baidu.com/s/aaa");
  });
});
