import type { IHotSearchStore, HotSearchItem, HotSearchStats, TopTerm, DaySnapshot, DayTerm } from "./hotSearchStore";
import { loggers } from "../utils/logger";
import { normalize, formatDateKey } from "./hotSearchUtils";

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

/**
 * 热搜存储：唯一真源 Turso（libSQL，HTTP 驱动，Worker/Docker/本地通用）。
 * 无回退链：未配置 TURSO_URL 时热搜功能不可用（明确报错，不静默降级）。
 */
export class HotSearchService {
  private store: IHotSearchStore | null = null;
  private storeType: "turso" | "unavailable" = "unavailable";
  private initPromise: Promise<void> | null = null;
  private initFailedLogged = false;
  private summaryLogged = false;
  /** 待落盘增量缓冲（同词多次搜索合并） */
  private pending = new Map<string, PendingTerm>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;

  constructor() {
    this.initPromise = this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      const { createTursoHotSearchStore } = await import("./tursoHotSearchStore");
      const store = createTursoHotSearchStore();
      await (store as any)["waitForInit"]?.();
      this.store = store;
      this.storeType = "turso";
      console.log("[HotSearchService] ✅ 使用 Turso 存储模式");
    } catch (err) {
      console.log(
        "[HotSearchService] ❌ Turso 初始化失败:",
        err instanceof Error ? err.message : err
      );
      console.log(
        "[HotSearchService] 热搜功能不可用。请配置 TURSO_URL / TURSO_AUTH_TOKEN（Worker 用 wrangler secret，Docker 用 .env）"
      );
    }
  }

  private async waitForInit(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
      this.initPromise = null;
    }
    if (!this.store && !this.initFailedLogged) {
      this.initFailedLogged = true;
      console.log("[HotSearchService] ⚠️ 热搜存储未就绪（TURSO_URL 未配置），相关接口将返回错误");
    }
  }

  /** 获取可用 store；未配置 Turso 时抛错（调用方转 500，前端提示配置） */
  private requireStore(): IHotSearchStore {
    if (!this.store) {
      throw new Error("热搜存储未配置：请设置环境变量 TURSO_URL / TURSO_AUTH_TOKEN");
    }
    return this.store;
  }

  /**
   * 热搜存储是否已就绪（Turso 已配置且初始化成功）。
   * 未配置时各 GET 接口返回空数据（不报错），页面表现为"没有热搜"。
   */
  async isReady(): Promise<boolean> {
    await this.waitForInit();
    return !!this.store;
  }

  async recordSearch(term: string): Promise<void> {
    // 写路径：先规范化，累积进内存缓冲，达到阈值或定时器批量落盘。
    // 不保证写后立即可读（读为随机词云/榜单，实时性要求低）。
    const normalized = normalize(term);
    if (!normalized) return;

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
      const store = this.store;
      if (!store) return; // 未配置 Turso：静默丢弃缓冲（热搜尽力而为），错误已在 waitForInit 记录一次
      for (const [term, p] of snapshot) {
        await store.recordSearch(term, p.lastAt, p.delta);
      }
      // 重算今天的 daily_stats（保持今天实时反映 current 累计 count 之和）。
      // 历史日期的口径由回填脚本一次性灌入；flush 只更新今天一行，避免叠加失真。
      const today = formatDateKey(Date.now());
      await store.recomputeDailySearches(today);
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
    const items = await this.requireStore().getHotSearches(limit);
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
    return this.requireStore().getRandomHotSearches(limit);
  }

  async clearHotSearches(): Promise<{ success: boolean; message: string }> {
    // 等当前 flush 完成，避免清空后仍在写的 flush 把旧数据写回
    if (this.flushing) await this.flushing;
    // 丢弃未落盘增量后清空，避免清空后缓冲又写回旧数据
    this.pending.clear();
    this.clearFlushTimer();
    await this.waitForInit();
    return this.requireStore().clearHotSearches();
  }

  async deleteHotSearch(term: string): Promise<{ success: boolean; message: string }> {
    // 先落盘缓冲（含待删词的增量），再删除，避免删除后缓冲复活该词
    await this.flush();
    return this.requireStore().deleteHotSearch(term);
  }

  async getStats(): Promise<{ total: number; topTerms: HotSearchItem[]; mode: string }> {
    await this.waitForInit();
    const stats = await this.requireStore().getStats();
    return {
      ...stats,
      mode: this.storeType,
    };
  }

  async getTopTerms(limit: number): Promise<TopTerm[]> {
    await this.waitForInit();
    return this.requireStore().getTopTerms(limit);
  }

  async getCalendar(days: number): Promise<DaySnapshot[]> {
    await this.waitForInit();
    return this.requireStore().getCalendar(days);
  }

  async getDayItems(date: string): Promise<DayTerm[]> {
    await this.waitForInit();
    return this.requireStore().getDayItems(date);
  }

  async getTotalSearches(): Promise<number> {
    await this.waitForInit();
    return this.requireStore().getTotalSearches();
  }

  async getTotalTerms(): Promise<number> {
    await this.waitForInit();
    return this.requireStore().getTotalTerms();
  }

  async getDailySearches(date: string): Promise<number> {
    await this.waitForInit();
    return this.requireStore().getDailySearches(date);
  }

  /** 一次性回填所有历史日期的 daily_stats（按 last_at 分组 SUM count）。返回写入的天数。 */
  async backfillDailyStats(): Promise<number> {
    await this.waitForInit();
    return this.requireStore().backfillDailyStats();
  }

  /**
   * 幂等保证：若 daily_stats 完全空（表刚建/被 clear），自动回填一遍。
   * 用本地标志防止每次请求都回填；进程重启后标志重置，会再次保证。
   */
  private dailyStatsBackfilled = false;
  async ensureDailyStatsBackfilled(): Promise<void> {
    if (this.dailyStatsBackfilled) return;
    if (!(await this.isReady())) return;
    const today = formatDateKey(Date.now());
    const todayVal = await this.getDailySearches(today);
    // 今日行已存在说明已回填（任何历史日期必有数据）
    if (todayVal > 0) {
      this.dailyStatsBackfilled = true;
      return;
    }
    // 今日行 = 0 时回填一遍历史；flush 后续仍会重算今天
    try {
      const written = await this.backfillDailyStats();
      console.log(`[HotSearchService] daily_stats 自动回填：${written} 个日期`);
      this.dailyStatsBackfilled = true;
    } catch (err) {
      console.log(
        "[HotSearchService] daily_stats 自动回填失败:",
        err instanceof Error ? err.message : err
      );
    }
  }

  getStoreType(): "turso" | "unavailable" {
    return this.storeType;
  }

  close(): void {
    this.clearFlushTimer();
    this.pending.clear();
    this.store?.close();
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
