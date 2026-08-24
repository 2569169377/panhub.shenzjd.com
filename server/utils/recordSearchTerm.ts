import { getOrCreateHotSearchService } from "../core/services/hotSearchService";
import { getOrCreateBotDefenseService } from "../core/services/botDefense";
import { loggers } from "../core/utils/logger";

/**
 * 同词去重（2026-08-22）：
 * 前端一次搜索按插件/TG 拆多个并发子请求，每个子请求都会走到这里，
 * 导致同一关键词被重复记录 N 次（实测"水子哥"18 秒内记录 43 次）。
 * 用模块级 Map 做短窗口去重：DEDUP_WINDOW_MS 内同一词只记录一次。
 */
const DEDUP_WINDOW_MS = 30_000;
/** 词条最大长度（防极端滥用撑爆存储；正常搜索词远小于此） */
const MAX_TERM_LENGTH = 200;
const recentTerms = new Map<string, number>();

/**
 * 词条格式过滤（2026-08-22 用户拍板：自己写过滤，排除明显非搜索内容）：
 * - 排除 URL / 绝对路径（http://、https://、www.、//、/\ 开头）
 * - 排除控制字符（不可见格式字符）
 * - 排除纯符号/纯标点/纯空白（至少含一个中文、字母或数字才算"搜索词"）
 * - 保留含标点片名（哈利·波特与魔法石、《繁花》等）——不重蹈 SAFE_TERM_RE 误杀覆辙
 */
const REJECT_URL_RE = /^(https?:\/\/|www\.|\/\/|\/\\|\\)/i;
const HAS_CONTROL_CHAR_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const HAS_CONTENT_RE = /[\u4e00-\u9fa5a-zA-Z0-9]/;

/** 词条是否应被过滤（返回 true 表示跳过不记录） */
export function isRejectedTerm(term: string | null | undefined): boolean {
  const t = (term || "").trim();
  if (!t) return true;
  if (t.length > MAX_TERM_LENGTH) return true;
  if (REJECT_URL_RE.test(t)) return true;
  if (HAS_CONTROL_CHAR_RE.test(t)) return true;
  // 至少含一个中文/字母/数字，排除纯标点、纯符号垃圾
  if (!HAS_CONTENT_RE.test(t)) return true;
  return false;
}

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
 * 2026-08-22 策略：
 * - 用户拍板"不限制用户搜索什么"：敏感词不过滤、含标点片名照常记录
 * - 但用户补充拍板：加格式校验，排除明显非搜索内容（URL/控制字符/纯符号）
 * - 保留：非空、长度上限（防滥用）、同词 30s 去重（防并发子请求重复计数）
 *
 * 防刷职责已前移到 search 接口入口（requireHumanOrCredential 对
 * bot UA 直接 403，连搜索都不执行），本层保证到达搜索的请求全部留痕。
 * 校验失败或写入失败均静默吞掉，绝不影响搜索主流程。
 */
export async function recordSearchTerm(term: string, ip?: string | null): Promise<void> {
  if (isRejectedTerm(term)) {
    const t = (term || "").trim();
    if (t.length > MAX_TERM_LENGTH) {
      loggers.hotSearch.warn(`跳过记录（超长）: ${t.length} chars`, ip ? { ip } : undefined);
    } else {
      loggers.hotSearch.warn(`跳过记录（词条非法）: ${JSON.stringify(term)}`, ip ? { ip } : undefined);
    }
    // 词条非法（URL/控制字符/纯符号）多半是脚本探测，真人不会发这类内容
    // 异步累积到 IP 黑名单，与 UA 拦截 + 限流形成三层独立证据
    if (ip) void getOrCreateBotDefenseService().recordRejection(ip, "bad_term");
    return;
  }
  const t = term.trim();
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
