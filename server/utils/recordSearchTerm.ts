import { getOrCreateHotSearchService } from "../core/services/hotSearchService";
import { loggers } from "../core/utils/logger";

// 只允许中文、英文、数字、空格（与 hot-searches.post.ts 保持一致）
const SAFE_TERM_RE = /^[一-龥a-zA-Z0-9 ]+$/;

/**
 * 记录搜索词（后端自动记录，替代前端上报）。
 *
 * 2026-08-21：搜索词入库从"前端上报 /api/hot-searches"迁移到
 * search 接口内自动记录 —— 覆盖所有渠道（Web/MP/爬虫/API 直调），
 * 数据更全且不依赖客户端行为。
 *
 * 2026-08-22 策略调整：**只要搜索就记录 + 打印日志**（用户拍板）。
 * 防刷职责已前移到 search 接口入口（requireHumanOrCredential 对
 * bot UA 直接 403，连搜索都不执行），因此本层不再做 UA/IP 过滤，
 * 保证到达搜索的请求全部留痕，便于排查问题。
 *
 * 仅保留词条合法性校验（防空/超长/URL/特殊字符污染词库）；
 * 记录成功打 info 日志（默认 LOG_LEVEL=info 可见，便于排查）。
 * 校验失败或写入失败均静默吞掉，绝不影响搜索主流程。
 *
 * 2026-08-22 补充：可选 ip 参数，记录日志时带上来源 IP，
 * 便于定位刷词来源（数据库不存 IP，靠日志留痕）。
 */
export async function recordSearchTerm(term: string, ip?: string | null): Promise<void> {
  const t = (term || "").trim();
  if (!t || t.length > 50 || !SAFE_TERM_RE.test(t)) {
    loggers.hotSearch.warn(`跳过记录（词条非法）: ${JSON.stringify(term)}`, ip ? { ip } : undefined);
    return;
  }

  try {
    const service = getOrCreateHotSearchService();
    await service.recordSearch(t);
    loggers.hotSearch.info(`记录搜索词: "${t}"`, ip ? { ip } : undefined);
  } catch {
    // 记录失败不影响搜索
  }
}
