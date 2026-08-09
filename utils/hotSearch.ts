/**
 * 热搜展示辅助工具
 * 新词判定与"X 分钟前"时间格式化，供首页快捷词和词云组件复用
 */

export const NEW_TERM_WINDOW_MS = 24 * 3600 * 1000;

/** 是否为新词（首次出现距今 < 24 小时） */
export function isNewTerm(createdAt: number, now: number = Date.now()): boolean {
  return now - createdAt < NEW_TERM_WINDOW_MS;
}

/** 距最近一次搜索的分钟数 */
export function minutesAgo(lastSearched: number, now: number = Date.now()): number {
  return Math.max(0, Math.round((now - lastSearched) / 60000));
}

/** 分钟数格式化为友好文本 */
export function formatAgo(minutes: number): string {
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}
