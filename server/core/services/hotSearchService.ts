import type { IHotSearchStore, HotSearchItem, HotSearchStats, TopTerm, DaySnapshot, DayTerm } from "./hotSearchStore";
import { MemoryHotSearchStore } from "./memoryHotSearchStore";
import { loggers } from "../utils/logger";
import { normalize, isForbidden } from "./hotSearchUtils";

/**
 * 写聚合缓冲配置
 * - FLUSH_MAX_PENDING：缓冲内不同词数达到该值立即落盘（请求内同步，Worker 可靠）
 * - FLUSH_INTERVAL_MS：兜底定时落盘（Node/Docker 可靠；Worker 空闲回收时可能丢失未落盘增量，
 *   热搜为尽力而为数据，可接受）
 */
const FLUSH_MAX_PENDING = 100;
const FLUSH_INTERVAL_MS = 3000;

/** 单个词的待落盘增量（同词多次搜索合并为一次 delta 写入） */
interface PendingTerm {
  delta: number;
  lastAt: number;
}

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

/**
 * 尝试创建 Turso 存储（libSQL HTTP 驱动，Worker/Docker 通用）。
 * - 显式 HOT_SEARCH_STORE=turso 强制启用
 * - 或自动检测到 TURSO_URL 配置时启用（优先于 D1，作为迁移目标）
 */
async function tryCreateTursoStore(): Promise<IHotSearchStore | null> {
  try {
    const { createTursoHotSearchStore } = await import("./tursoHotSearchStore");
    const store = createTursoHotSearchStore();
    await (store as any)["waitForInit"]?.();
    return store;
  } catch (err) {
    console.log(
      "[HotSearchService] Turso 存储不可用:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/** 是否具备 Turso 连接配置（TURSO_URL） */
function hasTursoConfig(): boolean {
  return !!process.env.TURSO_URL;
}

/**
 * 尝试创建 D1 REST 存储（Docker / 任意 Node 环境侧，读写与 Worker 同一份 D1 数据）。
 * - 显式 HOT_SEARCH_STORE=d1rest 强制启用
 * - 或自动检测到 D1_API_TOKEN / D1_ACCOUNT_ID / D1_DATABASE_ID 配置时启用
 */
async function tryCreateD1RestStore(): Promise<IHotSearchStore | null> {
  try {
    const { createD1RestHotSearchStore } = await import("./d1RestHotSearchStore");
    const store = createD1RestHotSearchStore();
    await (store as any)["waitForInit"]?.();
    return store;
  } catch (err) {
    console.log(
      "[HotSearchService] D1 REST 存储不可用:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/** 是否具备 D1 REST 连接配置 */
function hasD1RestConfig(): boolean {
  return !!(
    process.env.D1_API_TOKEN &&
    process.env.D1_ACCOUNT_ID &&
    process.env.D1_DATABASE_ID
  );
}

export class HotSearchService {
  private store: IHotSearchStore;
  private storeType: "sqlite" | "memory" | "d1" | "d1rest" | "turso";
  private initPromise: Promise<void> | null = null;
  private summaryLogged = false;
  /** 待落盘增量缓冲（同词多次搜索合并） */
  private pending = new Map<string, PendingTerm>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;

  constructor() {
    const memoryStore = getOrCreateSharedMemoryStore();
    this.store = memoryStore;
    this.storeType = "memory";
    this.initPromise = this.initializeWithFallback();
  }

  private async initializeWithFallback(): Promise<void> {
    // 显式指定 > 环境自动检测 > 回退链（turso → d1 → d1rest → sqlite → memory）
    const forced = process.env.HOT_SEARCH_STORE; // "turso" | "d1" | "d1rest" | "sqlite" | "memory"
    const wantTurso = forced === "turso" || (!forced && hasTursoConfig());
    const wantD1 = forced === "d1" || (!forced && hasD1Binding());
    const wantD1Rest =
      forced === "d1rest" || (!forced && !hasD1Binding() && hasD1RestConfig());
    const wantSqlite = forced === "sqlite" || !forced;

    if (wantTurso) {
      const tursoStore = await tryCreateTursoStore();
      if (tursoStore) {
        this.store = tursoStore;
        this.storeType = "turso";
        console.log("[HotSearchService] ✅ 使用 Turso 存储模式");
        return;
      }
    }

    if (wantD1) {
      const d1Store = await tryCreateD1Store();
      if (d1Store) {
        this.store = d1Store;
        this.storeType = "d1";
        console.log("[HotSearchService] ✅ 使用 D1 存储模式");
        return;
      }
    }

    if (wantD1Rest) {
      const d1RestStore = await tryCreateD1RestStore();
      if (d1RestStore) {
        this.store = d1RestStore;
        this.storeType = "d1rest";
        console.log("[HotSearchService] ✅ 使用 D1 REST 存储模式（共享 Worker 数据）");
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
    // 写路径：先规范化 + 过滤，累积进内存缓冲，达到阈值或定时器批量落盘。
    // 不保证写后立即可读（读为随机词云/榜单，实时性要求低）。
    const normalized = normalize(term);
    if (!normalized) return;
    if (isForbidden(normalized)) return;

    const now = Date.now();
    const cur = this.pending.get(normalized);
    if (cur) {
      cur.delta += 1;
      cur.lastAt = now;
    } else {
      this.pending.set(normalized, { delta: 1, lastAt: now });
    }

    if (this.pending.size >= FLUSH_MAX_PENDING) {
      await this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  /**
   * 将缓冲中的增量批量落盘到 store（同词合并为一次 delta 写入）。
   * 并发安全：flush 进行中时复用同一 Promise；期间新的 recordSearch 进入新的缓冲。
   */
  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.pending.size === 0) return;

    const snapshot = this.pending;
    this.pending = new Map();
    this.clearFlushTimer();

    this.flushing = (async () => {
      await this.waitForInit();
      for (const [term, p] of snapshot) {
        await this.store.recordSearch(term, p.lastAt, p.delta);
      }
    })()
      .catch((err) => {
        console.log(
          "[HotSearchService] flush 失败:",
          err instanceof Error ? err.message : err
        );
      })
      .finally(() => {
        this.flushing = null;
      });

    return this.flushing;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    // Node 下 unref，避免定时器阻止进程退出；CF Worker 无此方法则忽略
    const t = this.flushTimer as unknown as { unref?: () => void };
    t.unref?.();
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
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
    // 等当前 flush 完成，避免清空后仍在写的 flush 把旧数据写回
    if (this.flushing) await this.flushing;
    // 丢弃未落盘增量后清空，避免清空后缓冲又写回旧数据
    this.pending.clear();
    this.clearFlushTimer();
    await this.waitForInit();
    return this.store.clearHotSearches();
  }

  async deleteHotSearch(term: string): Promise<{ success: boolean; message: string }> {
    // 先落盘缓冲（含待删词的增量），再删除，避免删除后缓冲复活该词
    await this.flush();
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

  getStoreType(): "sqlite" | "memory" | "d1" | "d1rest" | "turso" {
    return this.storeType;
  }

  close(): void {
    this.clearFlushTimer();
    this.pending.clear();
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
