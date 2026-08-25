import { describe, it, expect } from "vitest";
import { load } from "cheerio";
import { parseChannelPage } from "../../server/core/services/tg";

function wrapMessage(text: string, post = "chan/1"): string {
  return `
    <div class="tgme_widget_message_wrap">
      <div class="tgme_widget_message" data-post="${post}">
        <div class="tgme_widget_message_text">${text}</div>
      </div>
      <time datetime="2026-01-01T00:00:00.000Z"></time>
    </div>`;
}

describe("parseChannelPage 链接提取", () => {
  it("展开 t.me 分享链接里嵌套的真实网盘地址（不被整体当成 t.me 丢弃）", () => {
    const html = wrapMessage(
      "资源 https://t.me/share/url?url=https://pan.quark.cn/s/abcdef 提取码：1234"
    );
    const $ = load(html);
    const results = parseChannelPage($, "testchan", "", 10);

    expect(results).toHaveLength(1);
    const quarkLinks = results[0].links.filter((l) => l.type === "quark");
    expect(quarkLinks).toHaveLength(1);
    expect(quarkLinks[0].url).toBe("https://pan.quark.cn/s/abcdef");
  });

  it("仍然能直接提取普通网盘链接", () => {
    const html = wrapMessage("电影 https://pan.quark.cn/s/xyz");
    const $ = load(html);
    const results = parseChannelPage($, "testchan", "", 10);

    const quarkLinks = results[0].links.filter((l) => l.type === "quark");
    expect(quarkLinks).toHaveLength(1);
    expect(quarkLinks[0].url).toBe("https://pan.quark.cn/s/xyz");
  });

  it("115 频道用「访问码」术语时也能提取密码（修复前被静默丢弃）", () => {
    const html = wrapMessage(
      "豆瓣电影Top250[刮削] https://115.com/s/abcdef 访问码：x7k2"
    );
    const $ = load(html);
    const results = parseChannelPage($, "testchan", "", 10);

    expect(results).toHaveLength(1);
    const links = results[0].links.filter((l) => l.type === "115");
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe("https://115.com/s/abcdef");
    expect(links[0].password).toBe("x7k2");
  });

  it("访问码不带标点也能提取（如「访问码 x7k2」）", () => {
    const html = wrapMessage(
      "资源 https://115.com/s/abcdef 访问码 x7k2 其他说明"
    );
    const $ = load(html);
    const results = parseChannelPage($, "testchan", "", 10);

    const links = results[0].links.filter((l) => l.type === "115");
    expect(links).toHaveLength(1);
    expect(links[0].password).toBe("x7k2");
  });

  it("title 清洗后只剩孤立标点（如 firstLine='《'）时，兜底用 text 含内容的有效行", () => {
    // 模拟消息格式异常：第一行只剩孤立的"《"（被吞/截断/复制残留）
    // 修复前 title="《"（纯标点下发，用户反馈截图）；修复后从 text
    // 找含中文的有效行作为 title
    const html = wrapMessage(
      "《\n使徒行者》全集 高清\nhttps://www.aliyundrive.com/s/abc123"
    );
    const $ = load(html);
    const results = parseChannelPage($, "testchan", "使徒行者", 10);

    expect(results).toHaveLength(1);
    expect(results[0].title).toContain("使徒行者");
    // 不能是纯标点
    expect(/^[\s《》【】\(\)]+$/.test(results[0].title)).toBe(false);
  });
});
