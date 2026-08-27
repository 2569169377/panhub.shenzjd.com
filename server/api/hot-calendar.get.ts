import { defineEventHandler, getQuery, createError } from "h3";
import { getOrCreateHotSearchService } from "../core/services/hotSearchService";
import { formatDateKey } from "../core/services/hotSearchUtils";

/**
 * 每日榜单日历：近 N 天每天的词数与 top3（供日历热力图使用）
 * 附带量级统计：累计词数 / 今日词数（精确），以及从部署起精确记录的每日搜索次数。
 * GET /api/hot-calendar?days=30
 *
 * 搜索次数口径（2026-08-22 用户拍板）：
 * - search_terms.count 是每词历史累计值，无法精确拆分"今日新增"→ 不展示累计搜索次数
 * - 新增 daily_searches 表：从部署起每次搜索 +delta 精确记录，攒满 7 天（searchesReady）
 *   前端才展示今日搜索次数，避免 0 或虚高误导
 */
export default defineEventHandler(async (event) => {
  const service = getOrCreateHotSearchService();
  const query = getQuery(event);
  const days = parseInt((query.days as string) || "30", 10);

  if (isNaN(days) || days < 1 || days > 90) {
    throw createError({ statusCode: 400, message: "days 参数无效，范围 1-90" });
  }

  if (!(await service.isReady())) {
    // 未配置 Turso：返回空日历（页面表现为无热搜历史），不报错
    return {
      code: 0,
      message: "success",
      data: {
        days: [],
        totalTerms: 0,
        todayTerms: 0,
        todaySearches: 0,
        searchesReady: false,
        configured: false,
      },
    };
  }

  const today = formatDateKey(Date.now());
  const [daysData, meta, todaySearches] = await Promise.all([
    service.getCalendar(days),
    service.getCalendarMeta(),
    service.getDailySearches(today),
  ]);

  const totalTerms = meta.totalTerms;
  const searchesDayCount = meta.dailyDayCount;
  const todayTerms = daysData.find((d) => d.date === today)?.count ?? 0;

  return {
    code: 0,
    message: "success",
    data: {
      days: daysData,
      totalTerms,
      todayTerms,
      todaySearches,
      // 2026-08-25 用户拍板：去掉"攒满 7 天才展示次数"门槛——
      // 只要今日有搜索次数（>0）就展示（daily_searches 从部署起精确记录，
      // 4 天数据已足够真实），避免页面显得数据少
      searchesReady: todaySearches > 0,
      configured: true,
    },
  };
});
