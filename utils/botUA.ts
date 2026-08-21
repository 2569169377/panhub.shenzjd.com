/**
 * 爬虫/脚本 User-Agent 检测（前后端共享）
 *
 * 用途：
 * - server：记录热搜前过滤（recordSearchTerm），切断 sitemap 自举与外部刷词
 * - client：首页 /?q=xxx 自动搜索前判断，爬虫抓取时连搜索请求都不发起
 *
 * 无 UA 一律返回 false（小程序等真实渠道可能不带标准 UA，避免误伤）。
 */

// 已知爬虫/搜索引擎/脚本抓取 UA 关键词（命中即判定为爬虫）
const BOT_UA_PATTERNS: RegExp[] = [
  // 通用爬虫标识
  /bot|crawler|spider|slurp|preview|scrape/i,
  // 常见脚本/HTTP 客户端（无浏览器特征）
  /curl|wget|python-requests|python-urllib|node-fetch|axios|go-http-client|okhttp|postman|http-client|java\/|libwww/i,
  // 主流搜索引擎
  /googlebot|baiduspider|bingbot|yandex|sogou|360spider|bytespider|semrush|ahrefs|mj12|duckduckbot|petalbot|applebot|ia_archiver|yisouspider|toutiaospider|facebookexternalhit|twitterbot|linkedinbot|pinterestbot|exabot|gptbot|claudebot/i,
];

/** 判断 User-Agent 是否为已知爬虫/脚本抓取工具。命中返回 true → 应跳过热搜记录/自动搜索。 */
export function isBotUA(ua: string | undefined | null): boolean {
  if (!ua) return false;
  return BOT_UA_PATTERNS.some((re) => re.test(ua));
}
