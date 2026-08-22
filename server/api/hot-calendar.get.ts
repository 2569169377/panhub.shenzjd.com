import { defineEventHandler, getQuery, createError } from "h3";
import { getOrCreateHotSearchService } from "../core/services/hotSearchService";

/**
 * 每日榜单日历：近 N 天每天的词数与 top3（供日历热力图使用）
 * 附带历史累计搜索总次数（全表 SUM(count)），供页面量级展示。
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
      data: { days: [], totalSearches: 0, configured: false },
    };
  }

  const [daysData, totalSearches] = await Promise.all([
    service.getCalendar(days),
    service.getTotalSearches(),
  ]);

  return {
    code: 0,
    message: "success",
    data: { days: daysData, totalSearches, configured: true },
  };
});
