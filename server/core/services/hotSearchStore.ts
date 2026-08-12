/**
 * 热搜索存储接口
 * 定义统一的存储操作，支持多种实现方式
 */
export interface IHotSearchStore {
  /**
   * 记录搜索词（增加分数）
   */
  recordSearch(term: string, now: number): Promise<void>;

  /**
   * 获取热搜列表
   */
  getHotSearches(limit: number): Promise<HotSearchItem[]>;

  /**
   * 清理超出限制的旧记录
   */
  cleanupOldEntries(maxEntries: number): Promise<void>;

  /**
   * 清除所有热搜记录
   */
  clearHotSearches(): Promise<{ success: boolean; message: string }>;

  /**
   * 删除指定热搜词
   */
  deleteHotSearch(term: string): Promise<{ success: boolean; message: string }>;

  /**
   * 获取热搜统计信息
   */
  getStats(): Promise<HotSearchStats>;

  /**
   * 懒生成当日榜单快照（无定时任务的 Serverless 环境友好）
   */
  ensureTodaySnapshot(): Promise<void>;

  /**
   * 获取飙升榜：对比今日与昨日榜单排名变化
   */
  getTrending(limit: number): Promise<TrendingItem[]>;

  /**
   * 获取高价值搜索词（按搜索次数降序，用于 SEO sitemap 选词）
   */
  getTopTerms(limit: number): Promise<TopTerm[]>;

  /**
   * 关闭存储连接
   */
  close(): void;
}

export interface HotSearchItem {
  term: string;
  score: number;
  lastSearched: number;
  createdAt: number;
  rank?: number;
  displayScore?: number;
}

export interface HotSearchStats {
  total: number;
  topTerms: HotSearchItem[];
}

export interface TrendingItem {
  term: string;
  rank: number;
  /** 昨日排名，null 表示新上榜 */
  prevRank: number | null;
  /** rank 变化量（正=上升，负=下降，新上榜取 rank 本身） */
  delta: number;
  score: number;
}

export interface TopTerm {
  term: string;
  count: number;
}
