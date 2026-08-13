import type { IHotSearchStore, HotSearchItem, HotSearchStats, TopTerm, DaySnapshot, DayTerm } from "./hotSearchStore";
import { loggers } from "../utils/logger";

/**
 * 与 SQLite 版保持一致的 EWMA 热度衰减：
 * λ=1.0 → 半衰期约 17 小时；score = score × e^(-λ×间隔天数) + 1
 */
const LAMBDA = 1.0;
const HOT_WINDOW_DAYS = 3;
const HOT_WINDOW_MS = HOT_WINDOW_DAYS * 86400000;

function decayScore(score: number, lastSearched: number, now: number): number {
  const elapsedDays = (now - lastSearched) / 86400000;
  return score * Math.exp(-LAMBDA * elapsedDays);
}

function formatDateKey(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 内存热搜存储实现
 * 用于 JSON 文件不可用时的降级方案（Vercel/CF 无持久化文件系统）
 */
export class MemoryHotSearchStore implements IHotSearchStore {
  private memoryStore = new Map<string, HotSearchItem>();
  private termDict = new Map<string, { count: number; firstAt: number; lastAt: number }>();
  private snapshots = new Map<string, Map<string, { rank: number; count: number }>>();

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

  async ensureTodaySnapshot(): Promise<void> {
    const date = formatDateKey(Date.now());
    const start = new Date(date + "T00:00:00").getTime();
    const end = start + 86400000;
    const dayTerms = Array.from(this.termDict.entries())
      .filter(([, v]) => v.lastAt >= start && v.lastAt < end)
      .sort((a, b) => b[1].count - a[1].count || b[1].lastAt - a[1].lastAt)
      .map(([term, v], index) => ({ term, rank: index + 1, count: v.count }));
    const map = new Map<string, { rank: number; count: number }>();
    dayTerms.forEach((t) => map.set(t.term, { rank: t.rank, count: t.count }));
    this.snapshots.set(date, map);
  }

  async getCalendar(days: number): Promise<DaySnapshot[]> {
    const safeDays = Math.min(Math.max(1, days), 90);
    const out: DaySnapshot[] = [];
    for (let i = safeDays - 1; i >= 0; i--) {
      const date = formatDateKey(Date.now() - i * 86400000);
      const map = this.snapshots.get(date);
      if (!map || map.size === 0) {
        out.push({ date, count: 0, top: [] });
        continue;
      }
      const top = Array.from(map.entries())
        .sort((a, b) => a[1].rank - b[1].rank)
        .slice(0, 3)
        .map(([term]) => term);
      out.push({ date, count: map.size, top });
    }
    return out;
  }

  async getDayItems(date: string): Promise<DayTerm[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
    const map = this.snapshots.get(date);
    if (!map) return [];
    return Array.from(map.entries())
      .map(([term, v]) => ({ term, rank: v.rank, count: v.count }))
      .sort((a, b) => a.rank - b.rank);
  }

  close(): void {
    this.memoryStore.clear();
    this.termDict.clear();
    this.snapshots.clear();
  }
}
