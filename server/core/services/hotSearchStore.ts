/**
 * 热搜索存储接口
 * 定义统一的存储操作，支持多种实现方式
 */
export interface IHotSearchStore {
  /**
   * 记录搜索词（增加分数）
   * @param term  搜索词
   * @param now   搜索时间戳（epoch ms）
   * @param delta 热度/计数增量，默认 1；批量聚合场景传入窗口内累计次数，
   *              一次写入合并 N 次搜索（score 衰减后 +delta、count +delta）
   */
  recordSearch(term: string, now: number, delta?: number): Promise<void>;

  /**
   * 获取热搜列表
   */
  getHotSearches(limit: number): Promise<HotSearchItem[]>;

  /**
   * 获取今日热搜词池的随机样本（首页词云用）
   * 数据源为全量词库 search_terms，按北京时间今日 0 点过滤，随机取 limit 条。
   * 理由：网盘搜索为超长尾需求，同词搜索人数极少，热度排名无统计意义，
   * 随机展示今日真实被搜过的词，保证每次刷新都有新鲜感。
   */
  getRandomHotSearches(limit: number): Promise<HotSearchItem[]>;

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
   * 获取每日榜单日历（近 N 天，每天词数与 top3）
   * 实时聚合 search_terms / termDict，日期按北京时间
   */
  getCalendar(days: number): Promise<DaySnapshot[]>;

  /**
   * 获取指定日期的全量词单
   */
  getDayItems(date: string): Promise<DayTerm[]>;

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

export interface TopTerm {
  term: string;
  count: number;
}

export interface DaySnapshot {
  /** 日期键 YYYY-MM-DD */
  date: string;
  /** 当天搜索词总数 */
  count: number;
  /** 当天热度最高的 3 个词 */
  top: string[];
}

export interface DayTerm {
  term: string;
  /** 当天排名（按搜索次数降序） */
  rank: number;
  /** 当天搜索次数 */
  count: number;
}
