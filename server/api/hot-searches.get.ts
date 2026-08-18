import { defineEventHandler, getQuery, createError } from "h3";
import { getOrCreateHotSearchService } from "../core/services/hotSearchService";

export default defineEventHandler(async (event) => {
  const service = getOrCreateHotSearchService();
  const query = getQuery(event);
  const limit = parseInt((query.limit as string) || "30", 10);

  if (isNaN(limit) || limit < 1 || limit > 100) {
    throw createError({ statusCode: 400, message: "limit 参数无效，范围 1-100" });
  }

  // 首页词云：随机取今日真实被搜过的词（超长尾场景下热度排名无统计意义，随机保证新鲜感）
  if (!(await service.isReady())) {
    // 未配置 Turso：返回空词云（页面表现为无热搜），不报错；configured:false 供部署者排查
    return {
      code: 0,
      message: "success",
      data: { hotSearches: [], configured: false },
    };
  }
  const hotSearches = await service.getRandomHotSearches(limit);

  const maxScore = hotSearches.length > 0 ? (hotSearches[0].displayScore ?? hotSearches[0].score) : 1;

  return {
    code: 0,
    message: "success",
    data: {
      hotSearches: hotSearches.map((item) => ({
        ...item,
        rank: item.rank ?? 0,
        displayScore: item.displayScore ?? item.score,
        heatPercent: maxScore > 0 ? Math.round(((item.displayScore ?? item.score) / maxScore) * 100) : 0,
      })),
      configured: true,
    },
  };
});
