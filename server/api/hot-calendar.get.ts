import { defineEventHandler, getQuery, createError } from "h3";
import { getOrCreateHotSearchService } from "../core/services/hotSearchService";
import { formatDateKey } from "../core/services/hotSearchUtils";

/**
 * 每日榜单日历：近 N 天每天的搜索词数与真实搜索次数（分离返回，不混用），
 * 附页头 4 指标：今日搜索次数 / 总搜索次数 / 今日搜索词数 / 总搜索词数。
 * GET /api/hot-calendar?days=30
 *
 * 口径（2026-08-30 用户拍板，替代 08-25"有次数显示次数，没次数显示词数"）：
 * - days[].searches：daily_searches 当天精确搜索次数（2026-08-22 部署起记录，
 *   无记录为 null）；日历格子只展示次数，无记录的天不显示数字
 * - days[].count：search_terms 当天词数（历史全有）；在当日词单面板展示
 * - totalSearches：search_terms 全表 SUM(count)，建库以来累计搜索次数
 * - totalTerms：search_terms 全表 COUNT(*)，累计搜索词数
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
        totalSearches: 0,
        todayTerms: 0,
        todaySearches: 0,
        configured: false,
      },
    };
  }

  const today = formatDateKey(Date.now());
  const [daysData, meta] = await Promise.all([
    service.getCalendar(days),
    service.getCalendarMeta(),
  ]);

  const todaySnapshot = daysData.find((d) => d.date === today);

  return {
    code: 0,
    message: "success",
    data: {
      days: daysData,
      totalTerms: meta.totalTerms,
      totalSearches: meta.totalSearches,
      todayTerms: todaySnapshot?.count ?? 0,
      todaySearches: todaySnapshot?.searches ?? 0,
      configured: true,
    },
  };
});
