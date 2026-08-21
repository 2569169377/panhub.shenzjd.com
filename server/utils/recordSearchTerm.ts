import { getOrCreateHotSearchService } from "../core/services/hotSearchService";
import { loggers } from "../core/utils/logger";
import { isBotUA } from "../../utils/botUA";

// 只允许中文、英文、数字、空格（与 hot-searches.post.ts 保持一致）
const SAFE_TERM_RE = /^[一-龥a-zA-Z0-9 ]+$/;

/**
 * 同 IP 写入节流配置（抗脚本换 UA 刷词的最后底线）
 * - THROTTLE_WINDOW_MS：窗口长度
 * - THROTTLE_LIMIT：窗口内最多记录多少条搜索词，超出丢弃
 * - 真人单次搜索只记 1 条，20 条/60s 远高于正常使用，不会误伤
 */
const THROTTLE_WINDOW_MS = 60_000;
const THROTTLE_LIMIT = 20;
const ipWindow = new Map<string, { count: number; resetAt: number }>();

/**
 * 同 IP 窗口限频：同一 IP 在窗口内累计记录超过 THROTTLE_LIMIT 条则返回 true（应丢弃）。
 * 无 IP 信息时放行（调用方未传时兜底，避免误伤）。
 */
export function isThrottledByIp(ip: string | undefined | null): boolean {
  if (!ip) return false;
  const now = Date.now();
  const cur = ipWindow.get(ip);
  if (!cur || now >= cur.resetAt) {
    ipWindow.set(ip, { count: 1, resetAt: now + THROTTLE_WINDOW_MS });
    return false;
  }
  cur.count += 1;
  return cur.count > THROTTLE_LIMIT;
}

/** 测试用：清空 IP 节流状态 */
export function resetIpThrottle(): void {
  ipWindow.clear();
}

/**
 * 记录搜索词（后端自动记录，替代前端上报）。
 *
 * 2026-08-21：搜索词入库从"前端上报 /api/hot-searches"迁移到
 * search 接口内自动记录 —— 覆盖所有渠道（Web/MP/爬虫/API 直调），
 * 数据更全且不依赖客户端行为。
 *
 * 2026-08-22：防污染三件套——
 * 1. 爬虫 UA 过滤：sitemap 将 TOP 词生成为 /?q=xxx URL，搜索引擎爬虫抓取时
 *    首页会自动触发搜索并记录，形成"词越热越被爬、越被爬越热"的自举循环。
 *    命中爬虫 UA 直接跳过，切断自举；GET 接口同步不再记录（见 search.get.ts）。
 * 2. 同 IP 节流：脚本换 UA 绕过过滤时，同一 IP 窗口内超量丢弃（抗刷底线）。
 *
 * 校验失败或写入失败均静默吞掉，绝不影响搜索主流程。
 */
export async function recordSearchTerm(term: string, ua?: string | null, ip?: string | null): Promise<void> {
  const t = (term || "").trim();
  if (!t || t.length > 50 || !SAFE_TERM_RE.test(t)) return;
  // 爬虫/脚本 UA 不记录（sitemap 自举 + 外部刷词防护）
  if (isBotUA(ua)) return;
  // 同 IP 窗口节流（脚本换 UA 刷词的底线）
  if (isThrottledByIp(ip)) return;

  try {
    const service = getOrCreateHotSearchService();
    await service.recordSearch(t);
    loggers.hotSearch.debug(`记录热搜: "${t}"`);
  } catch {
    // 记录失败不影响搜索
  }
}

export { isBotUA };
