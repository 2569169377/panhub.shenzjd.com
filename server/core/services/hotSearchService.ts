import type { IHotSearchStore, HotSearchItem, HotSearchStats, TopTerm, DaySnapshot, DayTerm } from "./hotSearchStore";
import { MemoryHotSearchStore } from "./memoryHotSearchStore";
import { loggers } from "../utils/logger";

let sharedMemoryStore: MemoryHotSearchStore | null = null;

function getOrCreateSharedMemoryStore(): MemoryHotSearchStore {
  if (!sharedMemoryStore) {
    sharedMemoryStore = new MemoryHotSearchStore();
  }
  return sharedMemoryStore;
}

async function tryCreateSqliteStore(): Promise<IHotSearchStore | null> {
  try {
    const { SqliteHotSearchStore } = await import("./sqliteHotSearchStore");
    const store = new SqliteHotSearchStore();
    await (store as any)["waitForInit"]?.();
    return store;
  } catch {
    return null;
  }
}

/**
 * 尝试创建 D1 存储（Cloudflare Workers 环境）。
 * - 显式 HOT_SEARCH_STORE=d1 强制启用
 * - 或自动检测到 D1 binding（process.env.DB）时启用
 */
async function tryCreateD1Store(): Promise<IHotSearchStore | null> {
  try {
    const { D1HotSearchStore } = await import("./d1HotSearchStore");
    const store = new D1HotSearchStore();
    await (store as any)["waitForInit"]?.();
    return store;
  } catch (err) {
    console.log(
      "[HotSearchService] D1 存储不可用:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/** 当前环境是否具备 D1 binding（Nitro cloudflare preset 注入到 process.env.DB） */
function hasD1Binding(): boolean {
  return !!(process.env as any).DB;
}

export class HotSearchService {
  private store: IHotSearchStore;
  private storeType: "sqlite" | "memory" | "d1";
  private initPromise: Promise<void> | null = null;
  private summaryLogged = false;

  constructor() {
    const memoryStore = getOrCreateSharedMemoryStore();
    this.store = memoryStore;
    this.storeType = "memory";
    this.initPromise = this.initializeWithFallback();
  }

  private async initializeWithFallback(): Promise<void> {
    // 显式指定 > 环境自动检测 > sqlite > memory 的回退链
    const forced = process.env.HOT_SEARCH_STORE; // "d1" | "sqlite" | "memory"
    const wantD1 = forced === "d1" || (!forced && hasD1Binding());
    const wantSqlite = forced === "sqlite" || !forced;

    if (wantD1) {
      const d1Store = await tryCreateD1Store();
      if (d1Store) {
        this.store = d1Store;
        this.storeType = "d1";
        console.log("[HotSearchService] ✅ 使用 D1 存储模式");
        return;
      }
    }

    if (wantSqlite) {
      const sqliteStore = await tryCreateSqliteStore();
      if (sqliteStore) {
        this.store = sqliteStore;
        this.storeType = "sqlite";
        console.log("[HotSearchService] ✅ 使用 SQLite 存储模式");
        return;
      }
    }

    console.log("[HotSearchService] ⚠️ 持久化存储不可用，使用内存存储模式");
  }

  private async waitForInit(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
      this.initPromise = null;
    }
  }

  async recordSearch(term: string): Promise<void> {
    await this.waitForInit();
    const now = Date.now();
    await this.store.recordSearch(term, now);
  }

  async getHotSearches(limit: number = 30): Promise<HotSearchItem[]> {
    await this.waitForInit();
    const items = await this.store.getHotSearches(limit);
    // 启动后首次读取时输出榜单摘要，便于线上观测（只打一次，避免刷日志）
    if (!this.summaryLogged) {
      this.summaryLogged = true;
      loggers.hotSearch.info("热搜榜单摘要", {
        total: items.length,
        top5: items.slice(0, 5).map((i) => ({
          term: i.term,
          score: Math.round((i.displayScore ?? i.score) * 100) / 100,
        })),
      });
    }
    return items;
  }

  /** 今日热搜词池随机抽样（首页词云展示用） */
  async getRandomHotSearches(limit: number = 25): Promise<HotSearchItem[]> {
    await this.waitForInit();
    return this.store.getRandomHotSearches(limit);
  }

  async clearHotSearches(): Promise<{ success: boolean; message: string }> {
    await this.waitForInit();
    return this.store.clearHotSearches();
  }

  async deleteHotSearch(term: string): Promise<{ success: boolean; message: string }> {
    await this.waitForInit();
    return this.store.deleteHotSearch(term);
  }

  async getStats(): Promise<{ total: number; topTerms: HotSearchItem[]; mode: string }> {
    await this.waitForInit();
    const stats = await this.store.getStats();
    return {
      ...stats,
      mode: this.storeType,
    };
  }

  async getTopTerms(limit: number): Promise<TopTerm[]> {
    await this.waitForInit();
    return this.store.getTopTerms(limit);
  }

  async getCalendar(days: number): Promise<DaySnapshot[]> {
    await this.waitForInit();
    return this.store.getCalendar(days);
  }

  async getDayItems(date: string): Promise<DayTerm[]> {
    await this.waitForInit();
    return this.store.getDayItems(date);
  }

  getDatabaseSize(): number {
    if (this.storeType === "sqlite") {
      try {
        return (this.store as any).getDbSize?.() ?? 0;
      } catch { return 0; }
    }
    return 0;
  }

  getStoreType(): "sqlite" | "memory" | "d1" {
    return this.storeType;
  }

  close(): void {
    this.store.close();
  }
}

const HOT_SEARCH_SERVICE_KEY = "__panhub_hot_search_service_v3__";

export function getOrCreateHotSearchService(): HotSearchService {
  const context = (globalThis as any)[HOT_SEARCH_SERVICE_KEY];
  if (context?.service) {
    return context.service;
  }

  const service = new HotSearchService();
  (globalThis as any)[HOT_SEARCH_SERVICE_KEY] = { service };
  return service;
}

export function resetHotSearchService(): void {
  const context = (globalThis as any)[HOT_SEARCH_SERVICE_KEY];
  if (context?.service) {
    context.service.close();
  }
  delete (globalThis as any)[HOT_SEARCH_SERVICE_KEY];
}

export type { HotSearchItem, HotSearchStats, TopTerm, DaySnapshot, DayTerm };
