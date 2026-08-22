import { defineEventHandler, getQuery, createError } from "h3";
import { getOrCreateHotSearchService } from "../core/services/hotSearchService";
import { formatDateKey } from "../core/services/hotSearchUtils";

/**
 * 每日榜单日历：近 N 天每天的词数与 top3（供日历热力图使用）
 * 附带量级统计：历史累计搜索总次数 / 词库累计词数 / 今日搜索次数 / 今日搜索词数。
 * GET /api/hot-calendar?days=30
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
        totalSearches: 0,
        totalTerms: 0,
        todaySearches: 0,
        todayTerms: 0,
        configured: false,
      },
    };
  }

  // 幂等：daily_stats 表空时自动回填一遍（首次部署/clear 后）
  await service.ensureDailyStatsBackfilled();

  const today = formatDateKey(Date.now());
  const [daysData, totalSearches, totalTerms, todaySearches] = await Promise.all([
    service.getCalendar(days),
    service.getTotalSearches(),
    service.getTotalTerms(),
    service.getDailySearches(today),
  ]);

  return {
    code: 0,
    message: "success",
    data: {
      days: daysData,
      totalSearches,
      totalTerms,
      todaySearches,
      todayTerms: daysData.find((d) => d.date === today)?.count ?? 0,
      configured: true,
    },
  };
});
