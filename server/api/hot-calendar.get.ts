import { defineEventHandler, getQuery, createError } from "h3";
import { getOrCreateHotSearchService } from "../core/services/hotSearchService";

/**
 * 每日榜单日历：近 N 天每天的词数与 top3（供日历热力图使用）
 * GET /api/hot-calendar?days=30
 */
export default defineEventHandler(async (event) => {
  const service = getOrCreateHotSearchService();
  const query = getQuery(event);
  const days = parseInt((query.days as string) || "30", 10);

  if (isNaN(days) || days < 1 || days > 90) {
    throw createError({ statusCode: 400, message: "days 参数无效，范围 1-90" });
  }

  const daysData = await service.getCalendar(days);

  return {
    code: 0,
    message: "success",
    data: { days: daysData },
  };
});
