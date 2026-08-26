import { describe, it, expect } from "vitest";
import { parseU3c3Html } from "../../server/core/plugins/u3c3";

// 2026-08-27：yunso 已从注册表移除（上游 wd 参数失效返回固定推荐列表），
// 原 plugin-yunso-u3c3.test.ts 中的 yunso parser 用例随之删除。
// 本文件只保留 u3c3 parser 用例。

// 取自真实响应结构的精简 fixture（u3c3: 种子列表表格）
const U3C3_HTML = `
<table class="table table-bordered table-hover table-striped torrent-list">
<tr><th>Category</th><th>Name</th><th>Link</th><th>Size</th><th>Date</th><th>Cloud</th><th>App</th></tr>
<tr class="default"><td><a href="/?type=U3C3&p=1"><img></a></td><td><a href="/?type=U3C3&p=1"><span><b>某动漫 第一季</b></span></a></td><td class="text-center"><a href="/torrent/x.torrent"><i download></i></a><a href="magnet:?xt=urn:btih:AAA111&tr=http%3A%2F%2Ftracker.wf%3A8888%2Fannounce"><i magnet></i></a></td><td class="text-center">2GB</td><td class="text-center">2024-05-01 12:00:00</td><td></td><td></td></tr>
<tr class="default"><td><a href="/?type=U3C3&p=1"><img></a></td><td><a href="/?type=U3C3&p=1"><span><b>某电影 1080P</b></span></a></td><td class="text-center"><a href="/torrent/y.torrent"><i download></i></a><a href="magnet:?xt=urn:btih:BBB222"><i magnet></i></a></td><td class="text-center">5GB</td><td class="text-center">2023-01-15 08:30:00</td><td></td><td></td></tr>
</table>
`;

describe("u3c3 parser", () => {
  it("提取磁力链接 + 名称 + 日期，跳过表头行", () => {
    const r = parseU3c3Html(U3C3_HTML, "测试");
    expect(r.length).toBe(2);
    expect(r[0].links[0].type).toBe("magnet");
    expect(r[0].links[0].url).toContain("btih:AAA111");
    expect(r[0].title).toContain("某动漫 第一季");
    expect(r[0].datetime).toContain("2024-05-01");
    expect(r[1].links[0].url).toContain("btih:BBB222");
    expect(r[1].datetime).toContain("2023-01-15");
  });
});
