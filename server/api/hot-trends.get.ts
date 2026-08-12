import { defineEventHandler, getQuery, createError } from "h3";
import { getOrCreateHotSearchService } from "../core/services/hotSearchService";

export default defineEventHandler(async (event) => {
  const service = getOrCreateHotSearchService();
  const query = getQuery(event);
  const limit = parseInt((query.limit as string) || "20", 10);

  if (isNaN(limit) || limit < 1 || limit > 50) {
    throw createError({ statusCode: 400, message: "limit 参数无效，范围 1-50" });
  }

  const items = await service.getTrending(limit);

  return {
    code: 0,
    message: "success",
    data: { items },
  };
});
