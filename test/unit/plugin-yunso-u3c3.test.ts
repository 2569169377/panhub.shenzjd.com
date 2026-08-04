import { describe, it, expect } from "vitest";
import { parseYunsoHtml } from "../../server/core/plugins/yunso";
import { parseU3c3Html } from "../../server/core/plugins/u3c3";

// 取自真实响应结构的精简 fixture（yunso: data 字段内的 HTML 片段）
const YUNSO_HTML = `
<div class="responsive-container"><div style=""><a onclick="open_sid(this)" id="1" url="https:\\/\\/pan.quark.cn\\/s\\/abc123" pa="8888" rel="noreferrer" target="_blank" style=""><u>测试片A（全集）张三</u></a></div>
<div class="responsive-container"><div style=""><a onclick="open_sid(this)" id="2" url="https:\\/\\/pan.quark.cn\\/s\\/def456" pa="" rel="noreferrer" target="_blank" style=""><u>测试片B 李四</u></a></div>
<div class="feedback"><a href="javascript:;" onclick="x()">忽略</a></div>
`;

// 取自真实响应结构的精简 fixture（u3c3: 种子列表表格）
const U3C3_HTML = `
<table class="table table-bordered table-hover table-striped torrent-list">
<tr><th>Category</th><th>Name</th><th>Link</th><th>Size</th><th>Date</th><th>Cloud</th><th>App</th></tr>
<tr class="default"><td><a href="/?type=U3C3&p=1"><img></a></td><td><a href="/?type=U3C3&p=1"><span><b>某动漫 第一季</b></span></a></td><td class="text-center"><a href="/torrent/x.torrent"><i download></i></a><a href="magnet:?xt=urn:btih:AAA111&tr=http%3A%2F%2Ftracker.wf%3A8888%2Fannounce"><i magnet></i></a></td><td class="text-center">2GB</td><td class="text-center">2024-05-01 12:00:00</td><td></td><td></td></tr>
<tr class="default"><td><a href="/?type=U3C3&p=1"><img></a></td><td><a href="/?type=U3C3&p=1"><span><b>某电影 1080P</b></span></a></td><td class="text-center"><a href="/torrent/y.torrent"><i download></i></a><a href="magnet:?xt=urn:btih:BBB222"><i magnet></i></a></td><td class="text-center">5GB</td><td class="text-center">2023-01-15 08:30:00</td><td></td><td></td></tr>
</table>
`;

describe("yunso parser", () => {
  it("提取 quark 链接 + 标题 + 密码，并跳过无 url 属性的链接", () => {
    const r = parseYunsoHtml(YUNSO_HTML, "测试");
    // 仅 2 个带 url= 的结果锚点，feedback 的 <a> 被跳过
    expect(r.length).toBe(2);
    expect(r[0].links[0].url).toBe("https://pan.quark.cn/s/abc123");
    expect(r[0].links[0].type).toBe("quark");
    expect(r[0].links[0].password).toBe("8888");
    expect(r[0].title).toContain("测试片A");
    expect(r[1].links[0].url).toBe("https://pan.quark.cn/s/def456");
    expect(r[1].links[0].password).toBe("");
    expect(r[1].title).toContain("测试片B");
  });
});

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
