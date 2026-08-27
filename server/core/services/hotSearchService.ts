import type { IHotSearchStore, HotSearchItem, HotSearchStats, TopTerm, DaySnapshot, DayTerm } from "./hotSearchStore";
import { loggers } from "../utils/logger";
import { normalize, formatDateKey, beijingDayStart } from "./hotSearchUtils";
import { getSearchLogStore } from "./tursoSearchLogStore";

/**
 * 写聚合缓冲配置
 * - FLUSH_MAX_PENDING：缓冲内不同词数达到该值立即落盘（请求内同步，Worker 可靠）
 * - FLUSH_INTERVAL_MS：兜底定时落盘（Node/Docker 可靠；Worker 空闲回收时可能丢失未落盘增量，
 *   热搜为尽力而为数据，可接受）。2026-08-24：3s → 60s，降低数据库写往返频次
 *   （可被环境变量 HOT_SEARCH_FLUSH_INTERVAL_MS 覆盖）
 */
const FLUSH_MAX_PENDING = 100;
const FLUSH_INTERVAL_MS =
  Number(process.env.HOT_SEARCH_FLUSH_INTERVAL_MS) || 60_000;

/**
 * 读缓存 TTL（2026-08-24 新增：热搜读接口不再每次请求都查库）
 * - READ_TTL_FAST：词云/榜单等高频且实时性要求中的接口
 * - READ_TTL_SLOW：日历/统计等低频变化的历史聚合数据
 * 写 flush 成功后会清「按日期聚合」的读缓存（calendar:/day:/daily:，保证"今日词数"
 * 等聚合读及时反映新 flush 的数据，避免页头/列表口径在 TTL 内不一致的视觉 bug）；
 * 但保留首页 hot:/random: 与累计统计缓存，不徒增高频读次数。delete/clear 时清全部。
 */
const READ_TTL_FAST_MS = Number(process.env.HOT_SEARCH_READ_TTL_MS) || 60_000;
const READ_TTL_SLOW_MS = 5 * 60_000;
/** 读缓存容量上限（防内存无限增长，超限先清过期条目） */
const READ_CACHE_MAX = 500;

/** 单个词的待落盘增量（同词多次搜索合并为一次 delta 写入） */
interface PendingTerm {
  delta: number;
  lastAt: number;
}

/** 读缓存条目 */
interface ReadCacheEntry {
  value: unknown;
  expires: number;
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
  /** 读缓存（方法+参数 → 结果，TTL 过期自动刷新） */
  private readCache = new Map<string, ReadCacheEntry>();

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
   * 读缓存包装（2026-08-24）：TTL 内命中直接返回，避免每次请求查库。
   * 容量保护：超上限时先清过期条目，仍超则淘汰最旧一条（防止缓存无限膨胀）。
   */
  private async getCached<T>(
    key: string,
    ttlMs: number,
    fetcher: () => Promise<T>
  ): Promise<T> {
    const hit = this.readCache.get(key);
    if (hit && hit.expires > Date.now()) {
      return hit.value as T;
    }
    const value = await fetcher();
    if (this.readCache.size >= READ_CACHE_MAX) {
      const now = Date.now();
      for (const [k, v] of this.readCache) {
        if (v.expires <= now) this.readCache.delete(k);
      }
      if (this.readCache.size >= READ_CACHE_MAX) {
        // 仍满：淘汰最早过期的一条（Map 按插入序迭代）
        const oldestKey = this.readCache.keys().next().value as string | undefined;
        if (oldestKey) this.readCache.delete(oldestKey);
      }
    }
    this.readCache.set(key, { value, expires: Date.now() + ttlMs });
    return value;
  }

  /** 清空全部读缓存（delete/clear 后调用，保证删后立即可见） */
  private clearReadCache(): void {
    this.readCache.clear();
  }

  /**
   * 仅清「按日期聚合」的读缓存（calendar:/day:/daily:），保留首页 hot:/random:
   * 与累计统计(total_*) 缓存——避免 flush 把高流量首页缓存也打掉导致读次数徒增，
   * 同时解除页头"今日词数"与列表口径在 TTL 内不一致的视觉 bug。
   */
  private clearDateScopedReadCache(): void {
    for (const key of this.readCache.keys()) {
      if (key.startsWith("calendar:") || key.startsWith("day:") || key.startsWith("daily:")) {
        this.readCache.delete(key);
      }
    }
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
      // 按日期聚合增量（daily_searches 精确计数：从部署起每天一次 upsert，写放大极小）
      const dailyDelta = new Map<string, number>();
      for (const [term, p] of snapshot) {
        await store.recordSearch(term, p.lastAt, p.delta);
        const day = formatDateKey(p.lastAt);
        dailyDelta.set(day, (dailyDelta.get(day) ?? 0) + p.delta);
      }
      for (const [day, delta] of dailyDelta) {
        await store.recordDailySearches(day, delta);
      }
      // 落盘成功后只清「按日期聚合」的读缓存(calendar/day/daily)：
      // 避免页头"今日词数"与列表口径在 5min TTL 内不一致（如页头 60 / 列表 5），
      // 同时保留首页 hot/random 与累计统计缓存，不徒增高频读次数
      this.clearDateScopedReadCache();
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
    const items = await this.getCached(`hot:${limit}`, READ_TTL_FAST_MS, () =>
      this.requireStore().getHotSearches(limit)
    );
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

  /**
   * 今日热搜词池随机抽样（首页词云展示用；TTL 内缓存同一批词，60s 刷新）
   *
   * 2026-08-25 用户拍板：词云/词列表的"今天"用 search_terms today 活跃词
   * （last_at 在今天 + count desc）作为主源，**保持丰满**（今天 ~350 个
   * 活跃词）。search_log 上线当天去重仅 45 词，用于主页词云太稀。
   *
   * 后续：search_log 攒满一周后，再把 hover 次数切到 search_log 当天精确次数
   * （getDayItems 同步）。search_log 的明细仍只用于管理页排查，不参与展示主源。
   * search_terms 仍服务 sitemap 选词（getTopTerms）。
   */
  async getRandomHotSearches(limit: number = 25): Promise<HotSearchItem[]> {
    await this.waitForInit();
    return this.getCached(`random:${limit}`, READ_TTL_FAST_MS, () =>
      this.requireStore().getRandomHotSearches(limit)
    );
  }

  async clearHotSearches(): Promise<{ success: boolean; message: string }> {
    // 等当前 flush 完成，避免清空后仍在写的 flush 把旧数据写回
    if (this.flushing) await this.flushing;
    // 丢弃未落盘增量后清空，避免清空后缓冲又写回旧数据
    this.pending.clear();
    this.clearFlushTimer();
    await this.waitForInit();
    const result = await this.requireStore().clearHotSearches();
    // 清空后读缓存立即失效，避免旧榜单继续展示
    this.clearReadCache();
    return result;
  }

  async deleteHotSearch(term: string): Promise<{ success: boolean; message: string }> {
    // 先落盘缓冲（含待删词的增量），再删除，避免删除后缓冲复活该词
    await this.flush();
    const result = await this.requireStore().deleteHotSearch(term);
    // 删除后读缓存立即失效，避免被删词继续出现在榜单/词云
    this.clearReadCache();
    return result;
  }

  async getStats(): Promise<{ total: number; topTerms: HotSearchItem[]; mode: string }> {
    await this.waitForInit();
    const stats = await this.getCached("stats", READ_TTL_FAST_MS, () =>
      this.requireStore().getStats()
    );
    return {
      ...stats,
      mode: this.storeType,
    };
  }

  async getTopTerms(limit: number): Promise<TopTerm[]> {
    await this.waitForInit();
    return this.getCached(`topterms:${limit}`, READ_TTL_SLOW_MS, () =>
      this.requireStore().getTopTerms(limit)
    );
  }

  /**
   * 每日榜单日历：近 N 天每天词数 + top3（日历热力图）。
   * 2026-08-25 用户拍板：**有次数显示次数，没次数显示词数**——
   * 数字优先级：
   *   1. daily_searches 当天搜索次数（22 号起精确，量级最大）
   *   2. search_log 当天词数（今天起精确）
   *   3. search_terms 当天词数（历史全有，兜底展示不空白）
   * 等 daily_searches 攒满 30 天后再全量切次数口径。
   */
  async getCalendar(days: number): Promise<DaySnapshot[]> {
    await this.waitForInit();
    return this.getCached(`calendar:${days}`, READ_TTL_SLOW_MS, async () => {
      const safeDays = Math.min(Math.max(1, days), 90);
      const startTs =
        beijingDayStart(formatDateKey(Date.now())) - (safeDays - 1) * 86400000;
      const logStore = getSearchLogStore();
      // 1. daily_searches 当天次数（精确，有记录的天才在 map 中）
      const dailyByDate = await this.requireStore().getDailySearchesRange(startTs, safeDays);
      // 2. search_log 当天词数（今天起）
      const logDays = logStore
        ? await logStore.getDaySummaries(startTs, safeDays)
        : [];
      const logByDate = new Map(logDays.map((d) => [d.date, d]));
      // 3. search_terms 当天词数（历史全有，最终兜底）
      const termDays = await this.requireStore().getCalendar(safeDays);
      return termDays.map((td) => {
        const daily = dailyByDate.get(td.date);
        if (daily !== undefined && daily > 0) {
          return { ...td, count: daily }; // 有次数 → 显示次数
        }
        const log = logByDate.get(td.date);
        if (log && log.count > 0) return log; // 有 search_log 词数
        return td; // search_terms 词数兜底
      });
    });
  }

  /**
   * 某天热词列表（2026-08-25 用户拍板：今天用 search_terms 活跃词为主源）
   *
   * 数据源选择：
   * - search_terms 当天活跃词（last_at 当天 + count desc）—— 主源，丰满
   * - search_log 攒满一周后，再把 hover 次数切到 search_log 当天精确次数
   *
   * 历史日期（search_log 上线 8-25 之前）天然由 search_terms last_at 过滤
   * 给出，搜索行为连续，无空白期。
   */
  async getDayItems(date: string): Promise<DayTerm[]> {
    await this.waitForInit();
    return this.getCached(`day:${date}`, READ_TTL_SLOW_MS, () =>
      this.requireStore().getDayItems(date)
    );
  }

  async getTotalSearches(): Promise<number> {
    await this.waitForInit();
    return this.getCached("total_searches", READ_TTL_SLOW_MS, () =>
      this.requireStore().getTotalSearches()
    );
  }

  async getTotalTerms(): Promise<number> {
    await this.waitForInit();
    return this.getCached("total_terms", READ_TTL_SLOW_MS, () =>
      this.requireStore().getTotalTerms()
    );
  }

  async getDailySearches(date: string): Promise<number> {
    await this.waitForInit();
    return this.getCached(`daily:${date}`, READ_TTL_SLOW_MS, () =>
      this.requireStore().getDailySearches(date)
    );
  }

  /** 已精确记录搜索次数的天数（< 7 天时前端不展示次数，只展示词数） */
  async getDailySearchesDayCount(): Promise<number> {
    await this.waitForInit();
    return this.getCached("daily_daycount", READ_TTL_SLOW_MS, () =>
      this.requireStore().getDailySearchesDayCount()
    );
  }

  /**
   * 合并查 totalTerms + dailyDayCount（2026-08-27 优化：
   * hot-calendar 原并行调两个方法各打一次库，合并为一次 batch 往返）
   */
  async getCalendarMeta(): Promise<{
    totalTerms: number;
    dailyDayCount: number;
  }> {
    await this.waitForInit();
    return this.getCached("calendar_meta", READ_TTL_SLOW_MS, () =>
      this.requireStore().getTotalTermsAndDailyDayCount()
    );
  }

  getStoreType(): "turso" | "unavailable" {
    return this.storeType;
  }

  close(): void {
    this.clearFlushTimer();
    this.pending.clear();
    this.readCache.clear();
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
