import type { IHotSearchStore, HotSearchItem, HotSearchStats, TopTerm, DaySnapshot, DayTerm } from "./hotSearchStore";
import { loggers } from "../utils/logger";

/**
 * 与 SQLite 版保持一致的 EWMA 热度衰减：
 * λ=1.0 → 半衰期约 17 小时；score = score × e^(-λ×间隔天数) + 1
 */
const LAMBDA = 1.0;
const HOT_WINDOW_DAYS = 1;
const HOT_WINDOW_MS = HOT_WINDOW_DAYS * 86400000;

function decayScore(score: number, lastSearched: number, now: number): number {
  const elapsedDays = (now - lastSearched) / 86400000;
  return score * Math.exp(-LAMBDA * elapsedDays);
}

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
 * 内存热搜存储实现
 * 用于 JSON 文件不可用时的降级方案（Vercel/CF 无持久化文件系统）
 */
export class MemoryHotSearchStore implements IHotSearchStore {
  private memoryStore = new Map<string, HotSearchItem>();
  private termDict = new Map<string, { count: number; firstAt: number; lastAt: number }>();

  async recordSearch(term: string, now: number): Promise<void> {
    if (!term || term.trim().length === 0) return;

    const existing = this.memoryStore.get(term);
    if (existing) {
      // 指数加权：旧热度先按间隔衰减，再 +1，避免历史累计分数永久霸榜
      existing.score = decayScore(existing.score, existing.lastSearched, now) + 1;
      existing.lastSearched = now;
      // 搜索流水日志：每次搜索都记录（isNew=false 表示历史词）
      loggers.hotSearch.info("搜索词", { term, isNew: false });
    } else {
      this.memoryStore.set(term, {
        term,
        score: 1,
        lastSearched: now,
        createdAt: now,
      });
      // 搜索流水日志：新词首次出现（与 SQLite 版保持一致）
      loggers.hotSearch.info("搜索词", { term, isNew: true });
    }

    // 词库表：全量搜索词 + 计数（联想补全 / 飙升 / 未来智能化）
    const dict = this.termDict.get(term);
    if (dict) {
      dict.count += 1;
      dict.lastAt = now;
    } else {
      this.termDict.set(term, { count: 1, firstAt: now, lastAt: now });
    }
  }

  async getHotSearches(limit: number): Promise<HotSearchItem[]> {
    const now = Date.now();
    const cutoff = now - HOT_WINDOW_MS;
    return Array.from(this.memoryStore.values())
      .filter((item) => item.lastSearched >= cutoff)
      .map((item) => ({
        ...item,
        displayScore: Math.round(decayScore(item.score, item.lastSearched, now) * 100) / 100,
      }))
      .sort((a, b) => {
        const aScore = a.displayScore ?? 0;
        const bScore = b.displayScore ?? 0;
        if (aScore !== bScore) return bScore - aScore;
        return b.lastSearched - a.lastSearched;
      })
      .slice(0, limit);
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
    const now = Date.now();
    const cutoff = now - HOT_WINDOW_MS;

    // 先清理超过窗口期未搜索的旧词
    for (const [term, item] of this.memoryStore) {
      if (item.lastSearched < cutoff) {
        this.memoryStore.delete(term);
      }
    }

    const entries = Array.from(this.memoryStore.entries()).sort((a, b) => {
      const aScore = a[1].score ?? 0;
      const bScore = b[1].score ?? 0;
      if (aScore !== bScore) return bScore - aScore;
      return b[1].lastSearched - a[1].lastSearched;
    });

    if (entries.length > maxEntries) {
      entries.slice(maxEntries).forEach(([term]) => {
        this.memoryStore.delete(term);
      });
    }
  }

  async clearHotSearches(): Promise<{ success: boolean; message: string }> {
    this.memoryStore.clear();
    return { success: true, message: "热搜记录已清除" };
  }

  async deleteHotSearch(term: string): Promise<{ success: boolean; message: string }> {
    const deleted = this.memoryStore.delete(term);
    if (deleted) {
      return { success: true, message: `热搜词 "${term}" 已删除` };
    }
    return { success: false, message: "热搜词不存在" };
  }

  async getStats(): Promise<HotSearchStats> {
    const items = await this.getHotSearches(10);
    return {
      total: this.memoryStore.size,
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
    this.memoryStore.clear();
    this.termDict.clear();
  }
}
