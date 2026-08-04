import { BaseAsyncPlugin } from "./manager";
import type { SearchResult, Link } from "../types/models";
import { ofetch } from "ofetch";
import { extractLinksFromText, getLinkType, cleanHTML } from "./panLink";

// yunso 搜索插件（移植自 pansou yunso.go）
// 接口：POST https://www.yunso.net/api/Core/search2
// 返回 JSON，data 字段是转义后的 HTML 片段；每条结果在 <a url="..." pa="密码">标题</a> 中。
const BASE = "https://www.yunso.net/api/Core/search2";
const REFERER = "https://www.yunso.net/";

/**
 * 解析 yunso 的 data（HTML 字符串）为结构化结果。
 * 独立导出以便单测（无需网络）。
 */
export function parseYunsoHtml(html: string, kw?: string): SearchResult[] {
  const out: SearchResult[] = [];
  const anchorRe = /<a\b[^>]*\burl="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null) {
    const rawUrl = m[1].replace(/\\\/+/g, "/").trim();
    const type = getLinkType(rawUrl);
    // 只保留网盘/磁力类链接；普通网页链接跳过
    if (type === "others" && !rawUrl.startsWith("magnet:")) continue;
    const pa = /pa="([^"]*)"/i.exec(m[0]);
    const password = pa ? pa[1] : "";
    const title = (cleanHTML(m[2]) || kw || "yunso").slice(0, 200);
    const links: Link[] = [{ type, url: rawUrl, password: password || "" }];
    out.push({
      message_id: "",
      unique_id: `yunso-${rawUrl}`,
      channel: "",
      datetime: "",
      title,
      content: title,
      links,
    });
  }
  return out;
}

export class YunsoPlugin extends BaseAsyncPlugin {
  constructor() {
    super("yunso", 3);
  }

  override async search(
    keyword: string,
    ext?: Record<string, any>
  ): Promise<SearchResult[]> {
    const timeout = Math.max(
      3000,
      Number((ext as any)?.__plugin_timeout_ms) || 12000
    );
    const kw = (keyword || "").trim();
    if (!kw) return [];

    const resp = await ofetch<{ code?: number; data?: string }>(BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: REFERER,
        Referer: REFERER,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      },
      body: { wd: kw, page: 1 },
      timeout,
    }).catch(() => undefined);

    if (!resp || resp.code !== 0 || !resp.data) return [];
    return parseYunsoHtml(resp.data, kw);
  }
}
