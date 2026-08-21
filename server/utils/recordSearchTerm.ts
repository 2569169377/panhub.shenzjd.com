import { getOrCreateHotSearchService } from "../core/services/hotSearchService";
import { loggers } from "../core/utils/logger";

// 只允许中文、英文、数字、空格（与 hot-searches.post.ts 保持一致）
const SAFE_TERM_RE = /^[一-龥a-zA-Z0-9 ]+$/;

// 已知爬虫/搜索引擎/脚本抓取 UA 关键词（命中即跳过热搜记录，防 sitemap 自举与外部刷词）
const BOT_UA_PATTERNS: RegExp[] = [
  // 通用爬虫标识
  /bot|crawler|spider|slurp|preview|scrape/i,
  // 常见脚本/HTTP 客户端（无浏览器特征）
  /curl|wget|python-requests|python-urllib|node-fetch|axios|go-http-client|okhttp|postman|http-client|java\/|libwww/i,
  // 主流搜索引擎
  /googlebot|baiduspider|bingbot|yandex|sogou|360spider|bytespider|semrush|ahrefs|mj12|duckduckbot|petalbot|applebot|ia_archiver|yisouspider|toutiaospider|facebookexternalhit|twitterbot|linkedinbot|pinterestbot|exabot|gptbot|claudebot/i,
];

/**
 * 判断 User-Agent 是否为已知爬虫/脚本抓取工具。
 * 命中返回 true → 调用方应跳过热搜记录。
 * 无 UA 返回 false（小程序等渠道可能不带标准 UA，保留记录，避免误伤真实渠道）。
 */
export function isBotUA(ua: string | undefined | null): boolean {
  if (!ua) return false;
  return BOT_UA_PATTERNS.some((re) => re.test(ua));
}

/**
 * 记录搜索词（后端自动记录，替代前端上报）。
 *
 * 2026-08-21：搜索词入库从"前端上报 /api/hot-searches"迁移到
 * search 接口内自动记录 —— 覆盖所有渠道（Web/MP/爬虫/API 直调），
 * 数据更全且不依赖客户端行为。
 *
 * 2026-08-22：增加爬虫 UA 过滤 —— sitemap 将 TOP 词生成为 /?q=xxx URL，
 * 搜索引擎爬虫抓取时首页会自动触发搜索并记录，形成"词越热越被爬、
 * 越被爬越热"的自举循环（线上词库已混入大量带年份/资源包名的非人类词）。
 * 命中爬虫 UA 直接跳过，切断自举；GET 接口同步不再记录（见 search.get.ts）。
 *
 * 校验失败或写入失败均静默吞掉，绝不影响搜索主流程。
 */
export async function recordSearchTerm(term: string, ua?: string | null): Promise<void> {
  const t = (term || "").trim();
  if (!t || t.length > 50 || !SAFE_TERM_RE.test(t)) return;
  // 爬虫/脚本 UA 不记录（sitemap 自举 + 外部刷词防护）
  if (isBotUA(ua)) return;

  try {
    const service = getOrCreateHotSearchService();
    await service.recordSearch(t);
    loggers.hotSearch.debug(`记录热搜: "${t}"`);
  } catch {
    // 记录失败不影响搜索
  }
}
