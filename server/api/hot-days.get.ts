import { defineEventHandler, getQuery, createError } from "h3";
import { getOrCreateHotSearchService } from "../core/services/hotSearchService";

/**
 * 指定日期的全量搜索词单（日历热力图点击某天查看）
 * GET /api/hot-days?date=2026-08-12
 */
export default defineEventHandler(async (event) => {
  const service = getOrCreateHotSearchService();
  const query = getQuery(event);
  const date = ((query.date as string) || "").trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw createError({ statusCode: 400, message: "date 参数无效，需为 YYYY-MM-DD" });
  }

  const items = await service.getDayItems(date);

  return {
    code: 0,
    message: "success",
    data: {
      date,
      total: items.length,
      items,
    },
  };
});
