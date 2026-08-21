import { getOrCreateHotSearchService } from "../core/services/hotSearchService";
import { loggers } from "../core/utils/logger";

/**
 * 词条合法性校验：
 * - 允许中文、英文、数字、空格
 * - 允许常见标点（间隔号·、书名号《》、引号"",''、连字符-、点.、冒号:、括号()、斜杠/、逗号,、顿号、感叹号!、问号?、加号+、井号#、百分号%）
 *   —— 片名常带《》《·-》等标点（如"哈利·波特与魔法石"），此前只允许中英数空格会误杀真人搜索
 * - 仍拒绝 URL（http）、控制字符和明显垃圾符号
 */
const SAFE_TERM_RE = /^[\u4e00-\u9fa5a-zA-Z0-9  ·《》「」『』""''、，。！？：；（）()\-—·.+*/#%&@'’]+$/;
// 明确拒绝：URL、绝对路径
const REJECT_URL_RE = /^(https?:\/\/|www\.|\/\/)/i;

/**
 * 同词去重（2026-08-22 修复）：
 * 前端一次搜索按插件/TG 拆多个并发子请求，每个子请求都会走到这里，
 * 导致同一关键词被重复记录 N 次（实测"水子哥"18 秒内记录 43 次）。
 * 用模块级 Map 做短窗口去重：DEDUP_WINDOW_MS 内同一词只记录一次。
 */
const DEDUP_WINDOW_MS = 30_000;
const recentTerms = new Map<string, number>();

/** 测试用：清空去重缓存 */
export function resetTermDedup(): void {
  recentTerms.clear();
}

/** 是否在去重窗口内已记录过该词 */
function isDuplicateWithinWindow(term: string, now: number): boolean {
  const last = recentTerms.get(term);
  if (last !== undefined && now - last < DEDUP_WINDOW_MS) return true;
  recentTerms.set(term, now);
  // 简单防 Map 无限膨胀：超 10k 条时清掉过期的
  if (recentTerms.size > 10_000) {
    for (const [k, v] of recentTerms) {
      if (now - v >= DEDUP_WINDOW_MS) recentTerms.delete(k);
    }
  }
  return false;
}

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
 * 2026-08-22 修复：
 * - 词条校验放宽（允许片名常见标点，防误杀"哈利·波特与魔法石"）
 * - 同词 30s 去重（前端并发子请求导致同一词重复记录 N 次）
 *
 * 校验失败或写入失败均静默吞掉，绝不影响搜索主流程。
 */
export async function recordSearchTerm(term: string, ip?: string | null): Promise<void> {
  const t = (term || "").trim();
  if (!t || t.length > 50 || REJECT_URL_RE.test(t) || !SAFE_TERM_RE.test(t)) {
    loggers.hotSearch.warn(`跳过记录（词条非法）: ${JSON.stringify(term)}`, ip ? { ip } : undefined);
    return;
  }
  // 同词短窗口去重：前端并发子请求只记一次
  if (isDuplicateWithinWindow(t, Date.now())) {
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
