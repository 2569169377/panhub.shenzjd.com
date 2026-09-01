import { defineEventHandler } from "h3";
import { getOrCreateHotSearchService } from "../core/services/hotSearchService";
import { formatDateKey } from "../core/services/hotSearchUtils";

/**
 * 首页统计带数据源（2026-09-01，替代 /hot 每日榜单日历的页头指标）
 *
 * 公开页不再展示搜索词与逐日榜单，只在首页 hero 下方展示四个统计数：
 * - todayTerms：今日搜索词数（search_terms 当天活跃词口径）
 * - todaySearches：今日真实搜索次数（daily_searches 精确记录）
 * - totalSearches：累计搜索次数（search_terms 全表 SUM(count)）
 * - totalTerms：累计词数（search_terms 全表 COUNT(*)）
 *
 * 读成本：getCalendar(1)（2 条查询）+ getCalendarMeta（1 次 batch），
 * 全部命中 service 层 TTL 读缓存（60s/5min），常规流量下接近零查库。
 */
export default defineEventHandler(async (event) => {
  const service = getOrCreateHotSearchService();

  if (!(await service.isReady())) {
    // 未配置 Turso：返回全 0（页面统计带隐藏或显示 0），不报错
    return {
      code: 0,
      message: "success",
      data: {
        todayTerms: 0,
        todaySearches: 0,
        totalSearches: 0,
        totalTerms: 0,
        configured: false,
      },
    };
  }

  const today = formatDateKey(Date.now());
  const [todayData, meta] = await Promise.all([
    service.getCalendar(1),
    service.getCalendarMeta(),
  ]);

  return {
    code: 0,
    message: "success",
    data: {
      todayTerms: todayData[0]?.count ?? 0,
      todaySearches: todayData[0]?.searches ?? 0,
      totalSearches: meta.totalSearches,
      totalTerms: meta.totalTerms,
      configured: true,
    },
  };
});
