import { BaseAsyncPlugin } from "./manager";
import type { SearchResult, Link } from "../types/models";
import { ofetch } from "ofetch";
import { getLinkType, cleanHTML } from "./panLink";

// u3c3 搜索插件（移植自 pansou u3c3.go）
// 接口：GET https://u3c3u3c3.u3c3u3c3u3c3.com/?search=<kw>
// 返回完整 HTML 页面；结果在 class="torrent-list" 的表格里，每行一个种子。
const BASE = "https://u3c3u3c3.u3c3u3c3u3c3.com/?search=";

function toISO(s?: string): string {
  if (!s) return "";
  const d = new Date(s.trim());
  return isNaN(d.getTime()) ? "" : d.toISOString();
}

/**
 * 解析 u3c3 的种子列表 HTML 为结构化结果。
 * 独立导出以便单测（无需网络）。
 */
export function parseU3c3Html(html: string, kw?: string): SearchResult[] {
  const out: SearchResult[] = [];
  const tableMatch = /<table[^>]*torrent-list[^>]*>([\s\S]*?)<\/table>/i.exec(
    html
  );
  const scope = tableMatch ? tableMatch[1] : html;
  const rows = scope.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];
  for (const row of rows) {
    if (/<th\b/i.test(row)) continue; // 跳过表头行
    const tds = row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
    if (tds.length < 2) continue;
    const name = (cleanHTML(tds[1]) || kw || "u3c3").slice(0, 200);
    const mag = /href="(magnet:\?xt=urn:btih:[^"]+)"/i.exec(row);
    if (!mag) continue;
    const url = mag[1];
    const type = getLinkType(url); // "magnet"
    const datetime = tds.length >= 5 ? toISO(cleanHTML(tds[4])) : "";
    const links: Link[] = [{ type, url, password: "" }];
    out.push({
      message_id: "",
      unique_id: `u3c3-${url}`,
      channel: "",
      datetime,
      title: name,
      content: name,
      links,
    });
  }
  return out;
}

export class U3c3Plugin extends BaseAsyncPlugin {
  constructor() {
    super("u3c3", 3);
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

    const url = `${BASE}${encodeURIComponent(kw)}`;
    const html = await ofetch<string>(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,*/*",
      },
      timeout,
    }).catch(() => undefined);

    if (!html || typeof html !== "string") return [];
    return parseU3c3Html(html, kw);
  }
}
