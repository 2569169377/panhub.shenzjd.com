import { normalizeIp } from "../../middleware/rateLimiter";
import { loggers } from "../utils/logger";

/**
 * Bot 防御服务（2026-08-24 用户拍板）
 *
 * 内存正/负缓存 + Turso 持久化黑名单真源（tursoBotDefenseStore）。
 * - recordRejection：累计同一 IP 的 reject 次数，达到阈值自动 extendBlock（24h）
 * - isBlocked：先查内存 cache，未命中查 Turso，回写缓存
 * - startMaintenance：周期性 pruneExpired，避免表无限膨胀
 *
 * Turso 不可用时降级为"不持久化"（仅靠内存拦截；服务重启后丢黑名单）。
 * 这种降级是安全选择：宁可临时漏拦，不要误把可恢复 IP 永久拉黑。
 *
 * 设计要点：
 * - 黑名单缓存 5min，负缓存 30s：前者保证拦截 hot path 极少触发 Turso 读，
 *   后者避免正常用户在短期内被反复 SELECT 同一 IP
 * - 阈值策略：同一 IP 在 60s 内累计 5 次 reject → 拉黑 24h
 *   既能逮住分布式低频攻击（被拦 5+ 次说明意图明显），也能容忍真人偶发误判
 * - recordRejection 静默吞错：拦截 hot path 不能因持久化失败拖慢搜索
 */

/** 黑名单内存缓存 TTL（热 path 长期命中） */
const POS_CACHE_TTL_MS = 5 * 60_000;
/** 负缓存 TTL（短时间内不再查同一个非黑名单 IP） */
const NEG_CACHE_TTL_MS = 30_000;
/** 拉黑阈值：同一 IP 累计拒绝次数 */
const HOT_THRESHOLD = 5;
/** 拉黑阈值时间窗（毫秒）：跨越此窗口累计的拒绝不算持续攻击 */
const HOT_WINDOW_MS = 60_000;
/** prune 周期 */
const PRUNE_INTERVAL_MS = 5 * 60_000;

interface CacheEntry {
  expiresAt: number;
}

export type RejectReason = "bot_ua" | "rate_limit" | "bad_term";

const BOT_DEFENSE_SERVICE_KEY = "__panhub_bot_defense_service_v1__";

export class BotDefenseService {
  private store: import("./tursoBotDefenseStore").TursoBotDefenseStore | null =
    null;
  private storeType: "turso" | "unavailable" = "unavailable";
  private initPromise: Promise<void> | null = null;
  private initFailedLogged = false;
  /** pos cache: ip -> 仍在黑名单的过期时间点 */
  private posCache = new Map<string, CacheEntry>();
  /** neg cache: ip -> 已知不在黑名单的过期时间点 */
  private negCache = new Map<string, CacheEntry>();
  /** hit 时间戳队列：判断是否在 HOT_WINDOW 内累计够了 HOT_THRESHOLD */
  private hitTimestamps = new Map<string, number[]>();
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.initPromise = this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      const { createTursoBotDefenseStore } = await import("./tursoBotDefenseStore");
      const s = createTursoBotDefenseStore();
      // store 内部 init 是 lazy 的，触发一次初始化就好（错误由 store 内部 catch 抛不抛都接受）
      try {
        await (s as any)["initPromise"];
      } catch {
        // 初始化失败也允许降级运行
      }
      this.store = s;
      this.storeType = "turso";
      console.log("[BotDefenseService] ✅ 使用 Turso 持久化黑名单");
    } catch (err) {
      console.log(
        "[BotDefenseService] ❌ Turso 初始化失败（将降级为纯内存拦截）:",
        err instanceof Error ? err.message : err
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
      console.log(
        "[BotDefenseService] ⚠️ 黑名单持久化不可用（仅靠内存，重启后丢失）"
      );
    }
  }

  private isUsableIp(ip: string): boolean {
    if (!ip || ip === "unknown") return false;
    const n = normalizeIp(ip);
    return n.length > 0;
  }

  /**
   * IP 是否在黑名单内（命中即拦截）。
   * 缓存层级：posCache(5min) → negCache(30s) → Turso store。
   * 任何错误一律放行（fail-open），避免持久化故障误伤真人。
   */
  async isBlocked(ip: string, now: number = Date.now()): Promise<boolean> {
    if (!this.isUsableIp(ip)) return false;
    await this.waitForInit();
    const nip = normalizeIp(ip);

    const pos = this.posCache.get(nip);
    if (pos && pos.expiresAt > now) return true;
    const neg = this.negCache.get(nip);
    if (neg && neg.expiresAt > now) return false;

    if (!this.store) return false;

    try {
      const blocked = await this.store.isBlocked(nip, now);
      if (blocked) {
        this.posCache.set(nip, { expiresAt: now + POS_CACHE_TTL_MS });
        this.negCache.delete(nip);
      } else {
        this.negCache.set(nip, { expiresAt: now + NEG_CACHE_TTL_MS });
        this.posCache.delete(nip);
      }
      return blocked;
    } catch (err) {
      loggers.api?.warn?.("黑名单查询失败，放行", {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * 记录一次拒绝事件（IP 命中拦截规则时被调用）。
   * - 入 store 累计 hit_count
   * - 在 60s 滑动窗口内累计达 5 次 → 自动 extendBlock（24h 拉黑）
   *
   * 完全静默：拦截 hot path 不因持久化失败拖慢。
   */
  async recordRejection(
    ip: string,
    reason: RejectReason,
    now: number = Date.now()
  ): Promise<void> {
    if (!this.isUsableIp(ip)) return;
    await this.waitForInit();
    const nip = normalizeIp(ip);
    if (!this.store) return;

    // 1. 滑动窗口累计（仅用于阈值判定，不入库）
    const recent = (this.hitTimestamps.get(nip) ?? []).filter(
      (t) => now - t <= HOT_WINDOW_MS
    );
    recent.push(now);
    this.hitTimestamps.set(nip, recent);

    // 2. 入库累计 hit_count（持久化）
    try {
      const { hitCount: storedCount } = await this.store.recordRejection(
        nip,
        reason,
        now
      );

      // 3. 阈值判定（用持久化命中次数，与滑动窗口交叉确认）
      const shouldBlock =
        storedCount >= HOT_THRESHOLD || recent.length >= HOT_THRESHOLD;

      if (shouldBlock) {
        await this.store.extendBlock(nip, reason, now);
        // 立刻写 pos cache，5min 内 isBlocked 直接走缓存
        this.posCache.set(nip, { expiresAt: now + POS_CACHE_TTL_MS });
        this.negCache.delete(nip);
        this.hitTimestamps.delete(nip);
        loggers.search?.warn?.("IP 拉黑（阈值）", {
          ip: nip,
          reason,
          hitCount: storedCount,
          recentInWindow: recent.length,
        });
      }
    } catch (err) {
      // 持久化失败不阻挡主流程
      loggers.api?.warn?.("recordRejection 失败", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 启动周期 prune（懒启动：首次获取服务时由 factory 触发） */
  startMaintenance(): void {
    if (this.pruneTimer) return;
    this.pruneTimer = setInterval(() => {
      void this.prune();
    }, PRUNE_INTERVAL_MS);
    const t = this.pruneTimer as unknown as { unref?: () => void };
    t.unref?.();
  }

  private async prune(): Promise<void> {
    if (!this.store) return;
    try {
      const deleted = await this.store.pruneExpired(Date.now());
      if (deleted > 0) {
        console.log(`[BotDefenseService] prune 过期条目 ${deleted} 条`);
      }
      // 顺便清掉过期缓存（极简实现：每次 prune 全清，由 TTL 重建）
      const now = Date.now();
      for (const [k, v] of this.posCache) {
        if (v.expiresAt <= now) this.posCache.delete(k);
      }
      for (const [k, v] of this.negCache) {
        if (v.expiresAt <= now) this.negCache.delete(k);
      }
    } catch (err) {
      console.log(
        "[BotDefenseService] prune 失败:",
        err instanceof Error ? err.message : err
      );
    }
  }

  /** 测试用：清空所有缓存与状态 */
  reset(): void {
    this.posCache.clear();
    this.negCache.clear();
    this.hitTimestamps.clear();
  }

  getStoreType(): "turso" | "unavailable" {
    return this.storeType;
  }
}

export function getOrCreateBotDefenseService(): BotDefenseService {
  const ctx = (globalThis as any)[BOT_DEFENSE_SERVICE_KEY];
  if (ctx?.service) {
    ctx.service.startMaintenance();
    return ctx.service;
  }
  const service = new BotDefenseService();
  (globalThis as any)[BOT_DEFENSE_SERVICE_KEY] = { service };
  service.startMaintenance();
  return service;
}
