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

  if (!(await service.isReady())) {
    // 未配置 Turso：返回空词单（页面表现为无数据），不报错
    return {
      code: 0,
      message: "success",
      data: { date, total: 0, items: [], configured: false },
    };
  }

  const items = await service.getDayItems(date);

  return {
    code: 0,
    message: "success",
    data: {
      date,
      total: items.length,
      items,
      configured: true,
    },
  };
});
