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
 * 校验失败或写入失败均静默吞掉，绝不影响搜索主流程。
 */
export async function recordSearchTerm(term: string): Promise<void> {
  const t = (term || "").trim();
  if (!t || t.length > 50 || !SAFE_TERM_RE.test(t)) return;

  try {
    const service = getOrCreateHotSearchService();
    await service.recordSearch(t);
    loggers.hotSearch.debug(`记录热搜: "${t}"`);
  } catch {
    // 记录失败不影响搜索
  }
}
