import type { IHotSearchStore, HotSearchItem, HotSearchStats, TrendingItem, TopTerm } from "./hotSearchStore";
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
  private snapshots = new Map<string, Map<string, number>>();

  async recordSearch(term: string, now: number): Promise<void> {
    if (!term || term.trim().length === 0) return;

    const existing = this.memoryStore.get(term);
    if (existing) {
      // 指数加权：旧热度先按间隔衰减，再 +1，避免历史累计分数永久霸榜
      existing.score = decayScore(existing.score, existing.lastSearched, now) + 1;
      existing.lastSearched = now;
    } else {
      this.memoryStore.set(term, {
        term,
        score: 1,
        lastSearched: now,
        createdAt: now,
      });
      // 观测日志：新词首次出现（与 SQLite 版保持一致）
      loggers.hotSearch.info("新词出现", { term });
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
    if (this.snapshots.has(date)) return;
    const items = await this.getHotSearches(30);
    const map = new Map<string, number>();
    items.forEach((item, index) => {
      map.set(item.term, index + 1);
    });
    this.snapshots.set(date, map);
  }

  async getTrending(limit: number): Promise<TrendingItem[]> {
    await this.ensureTodaySnapshot();
    const today = formatDateKey(Date.now());
    const yesterday = formatDateKey(Date.now() - 86400000);

    const todayMap = this.snapshots.get(today) ?? new Map<string, number>();
    const prevMap = this.snapshots.get(yesterday) ?? new Map<string, number>();

    const items: TrendingItem[] = Array.from(todayMap.entries()).map(([term, rank]) => {
      const prevRank = prevMap.get(term) ?? null;
      return {
        term,
        rank,
        prevRank,
        delta: prevRank === null ? rank : prevRank - rank,
        score: 0,
      };
    });

    items.sort((a, b) => {
      const aNew = a.prevRank === null;
      const bNew = b.prevRank === null;
      if (aNew && bNew) return a.rank - b.rank;
      if (aNew) return -1;
      if (bNew) return 1;
      if (b.delta !== a.delta) return b.delta - a.delta;
      return a.rank - b.rank;
    });

    return items.slice(0, Math.min(Math.max(1, limit), 100));
  }

  close(): void {
    this.memoryStore.clear();
    this.termDict.clear();
    this.snapshots.clear();
  }
}
