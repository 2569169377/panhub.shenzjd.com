import type { IHotSearchStore, HotSearchItem, HotSearchStats, TopTerm, DaySnapshot, DayTerm } from "./hotSearchStore";
import { loggers } from "../utils/logger";

/** 固定北京时间（UTC+8）日期键，不依赖宿主时区 */
function formatDateKey(ts: number): string {
  const d = new Date(ts + 8 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 北京时间 0 点对应的 epoch ms */
function beijingDayStart(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Date.UTC(y, m - 1, d) - 8 * 3600 * 1000;
}

/**
 * 内存热搜存储实现（降级兜底）
 * 用于持久化存储（Turso/SQLite）不可用时的降级方案（Vercel/CF 无持久化文件系统且未配 Turso）。
 * 一表化（2026-08-18）：只维护词库 termDict 单结构（对应 search_terms），无热榜双写。
 */
export class MemoryHotSearchStore implements IHotSearchStore {
  private termDict = new Map<string, { count: number; firstAt: number; lastAt: number }>();

  async recordSearch(term: string, now: number, delta = 1): Promise<void> {
    if (!term || term.trim().length === 0) return;
    const d = Math.max(1, delta);

    // 词库表：全量搜索词 + 计数（联想补全 / 飙升 / 词云数据源）
    const dict = this.termDict.get(term);
    if (dict) {
      dict.count += d;
      dict.lastAt = now;
      // 搜索流水日志：每次搜索都记录（isNew=false 表示历史词）
      loggers.hotSearch.info("搜索词", { term, isNew: false });
    } else {
      this.termDict.set(term, { count: d, firstAt: now, lastAt: now });
      // 搜索流水日志：新词首次出现（与 SQLite 版保持一致）
      loggers.hotSearch.info("搜索词", { term, isNew: true });
    }
  }

  /**
   * 获取热搜列表（按搜索次数降序；与 SQLite/Turso 语义一致：count 当 score）
   * 无生产调用方，保留接口兼容
   */
  async getHotSearches(limit: number): Promise<HotSearchItem[]> {
    return Array.from(this.termDict.entries())
      .sort((a, b) => b[1].count - a[1].count || b[1].lastAt - a[1].lastAt)
      .slice(0, Math.min(Math.max(1, limit), 100))
      .map(([term, v], index) => ({
        term,
        score: v.count,
        lastSearched: v.lastAt,
        createdAt: v.firstAt,
        rank: index + 1,
        displayScore: v.count,
      }));
  }

  /**
   * 今日热搜词池随机抽样（首页词云展示用）
   * 与 SQLite 版语义一致：北京时间今日 0 点后搜索过的词，Fisher-Yates 洗牌取前 limit 条
   */
  async getRandomHotSearches(limit: number): Promise<HotSearchItem[]> {
    const dayStart = beijingDayStart(formatDateKey(Date.now()));
    const pool = Array.from(this.termDict.entries())
      .filter(([term, v]) => v.lastAt >= dayStart)
      .map(([term, v]) => ({ term, count: v.count, firstAt: v.firstAt, lastAt: v.lastAt }));
    // Fisher-Yates 洗牌
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const safeLimit = Math.min(Math.max(1, limit), 100);
    return pool.slice(0, safeLimit).map((p, index) => ({
      term: p.term,
      score: p.count,
      lastSearched: p.lastAt,
      createdAt: p.firstAt,
      rank: index + 1,
      displayScore: p.count,
    }));
  }

  async cleanupOldEntries(maxEntries: number): Promise<void> {
    // 词库是全量数据（对应 search_terms，不清理），no-op 保持接口兼容
  }

  async clearHotSearches(): Promise<{ success: boolean; message: string }> {
    this.termDict.clear();
    return { success: true, message: "热搜记录已清除" };
  }

  async deleteHotSearch(term: string): Promise<{ success: boolean; message: string }> {
    const deleted = this.termDict.delete(term);
    if (deleted) {
      return { success: true, message: `热搜词 "${term}" 已删除` };
    }
    return { success: false, message: "热搜词不存在" };
  }

  async getStats(): Promise<HotSearchStats> {
    const items = await this.getHotSearches(10);
    return {
      total: this.termDict.size,
      topTerms: items,
    };
  }

  async getTopTerms(limit: number): Promise<TopTerm[]> {
    const safeLimit = Math.min(Math.max(1, limit), 50000);
    return Array.from(this.termDict.entries())
      .filter(([term, v]) => v.count >= 2 && term.length >= 2)
      .sort((a, b) => b[1].count - a[1].count || b[1].lastAt - a[1].lastAt)
      .map(([term, v]) => ({ term, count: v.count }))
      .slice(0, safeLimit);
  }

  /**
   * 日历：近 N 天每天词数与 top3（实时聚合 termDict，不依赖快照）
   */
  async getCalendar(days: number): Promise<DaySnapshot[]> {
    const safeDays = Math.min(Math.max(1, days), 90);
    // 按北京时间分桶：day -> terms
    const dayMap = new Map<string, Array<{ term: string; count: number; lastAt: number }>>();
    for (const [term, v] of this.termDict.entries()) {
      const day = formatDateKey(v.lastAt);
      const list = dayMap.get(day) ?? [];
      list.push({ term, count: v.count, lastAt: v.lastAt });
      dayMap.set(day, list);
    }
    const out: DaySnapshot[] = [];
    for (let i = safeDays - 1; i >= 0; i--) {
      const date = formatDateKey(Date.now() - i * 86400000);
      const list = dayMap.get(date);
      if (!list || list.length === 0) {
        out.push({ date, count: 0, top: [] });
        continue;
      }
      const top = list
        .slice()
        .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
        .slice(0, 3)
        .map((t) => t.term);
      out.push({ date, count: list.length, top });
    }
    return out;
  }

  async getDayItems(date: string): Promise<DayTerm[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
    const start = beijingDayStart(date);
    const end = start + 86400000;
    const items: DayTerm[] = [];
    for (const [term, v] of this.termDict.entries()) {
      if (v.lastAt >= start && v.lastAt < end) {
        items.push({ term, rank: 0, count: v.count });
      }
    }
    items.sort((a, b) => b.count - a.count);
    items.forEach((item, index) => (item.rank = index + 1));
    return items;
  }

  close(): void {
    this.termDict.clear();
  }
}
