import type { IHotSearchStore, HotSearchItem, HotSearchStats } from "./hotSearchStore";
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

/**
 * 内存热搜存储实现
 * 用于 JSON 文件不可用时的降级方案（Vercel/CF 无持久化文件系统）
 */
export class MemoryHotSearchStore implements IHotSearchStore {
  private memoryStore = new Map<string, HotSearchItem>();

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

  close(): void {
    this.memoryStore.clear();
  }
}
