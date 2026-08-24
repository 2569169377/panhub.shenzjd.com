import type { MergedLinks, GenericResponse, SearchResponse } from "~/types/search";
import { ALL_PLUGIN_NAMES } from "~/config/plugins";
import { extractMergedFromResponse } from "~/utils/extractMergedFromResponse";
import { mergeMergedByType } from "~/utils/mergeMergedByType";

const devLog = (...args: any[]) => {
  if (import.meta.dev) console.log(...args);
};
const devWarn = (...args: any[]) => {
  if (import.meta.dev) console.warn(...args);
};
const devError = (...args: any[]) => {
  if (import.meta.dev) console.error(...args);
};

/**
 * 每轮搜索（首搜或每次"继续"）的累计结果上限：
 * 达到后自动暂停，不再发起剩余请求，用户点击"继续"再搜下一轮（阈值累进 +90）。
 * 大部分用户只看前几条，几百条结果纯浪费服务器资源（尤其 TG 真爬请求）。
 */
const MAX_RESULTS_PER_ROUND = 90;

export interface SearchOptions {
  apiBase: string;
  keyword: string;
  settings: {
    enabledPlugins: string[];
    enabledTgChannels: string[];
    concurrency: number;
    pluginTimeoutMs: number;
  };
  /** 当搜索接口返回 401 时回调（密码门） */
  onAuthRequired?: () => void;
}

/**
 * 后端 TG 频道分批大小（2026-08-24 频道零落地改造后固定，
 * 必须与 server/core/utils/batchChannels.ts 的默认一致）
 */
const TG_BATCH_SIZE = 2;

export interface SearchState {
  loading: boolean;
  deepLoading: boolean;
  paused: boolean;
  error: string;
  searched: boolean;
  elapsedMs: number;
  total: number;
  merged: MergedLinks;
}

export function useSearch() {
  const state = ref<SearchState>({
    loading: false,
    deepLoading: false,
    paused: false,
    error: "",
    searched: false,
    elapsedMs: 0,
    total: 0,
    merged: {},
  });

  const setLoading = (v: boolean) => {
    state.value.loading = v;
  };
  const setDeepLoading = (v: boolean) => {
    state.value.deepLoading = v;
  };
  const setPaused = (v: boolean) => {
    state.value.paused = v;
  };
  const setError = (v: string) => {
    state.value.error = v;
  };
  const setSearched = (v: boolean) => {
    state.value.searched = v;
  };
  const setElapsedMs = (v: number) => {
    state.value.elapsedMs = v;
  };
  const setTotal = (v: number) => {
    state.value.total = v;
  };
  const setMerged = (v: MergedLinks) => {
    state.value.merged = v;
  };

  let searchSeq = 0;
  const activeControllers: AbortController[] = [];
  /** 暂停时已完成的任务数，供 continueSearch 从断点续跑 */
  let pausedAtTaskIndex = 0;
  /** 当前并搜已完成数，暂停时用于记录断点 */
  let parallelCompletedCount = 0;
  /** 当前轮次结果上限（首搜 50，每次继续 +50，累进 50→100→150） */
  let maxResultsThreshold = MAX_RESULTS_PER_ROUND;
  /** 是否因达到结果上限而自动暂停（区别于用户手动暂停，UI 文案用） */
  const autoPausedAtLimit = ref(false);

  // 取消所有进行中的请求
  function cancelActiveRequests(): void {
    for (const controller of activeControllers) {
      try {
        controller.abort();
      } catch {}
    }
    activeControllers.length = 0;
  }

  // 暂停搜索
  function pauseSearch(): void {
    if (state.value.loading || state.value.deepLoading) {
      autoPausedAtLimit.value = false;
      setPaused(true);
      pausedAtTaskIndex = parallelCompletedCount;
      cancelActiveRequests();
    }
  }

  // 续跑时复用上次 countOnly 拿到的批数（同一关键词的搜索）
  let lastTotalTgBatches = 0;
  let lastCountedKeyword = "";

  /** 向后端问"有 N 批"，不实际搜索（响应只有数字，无频道明文） */
  async function fetchTgBatchCount(apiBase: string, keyword: string): Promise<number> {
    try {
      const q = new URLSearchParams({
        kw: keyword,
        countOnly: "1",
        batchSize: String(TG_BATCH_SIZE),
        src: "tg",
      });
      const resp = await $fetch<GenericResponse<{ totalBatches: number }>>(
        `${apiBase}/search?${q.toString()}`,
        { credentials: "include" } as any
      );
      return Number(resp.data?.totalBatches) || 0;
    } catch (e) {
      devWarn("fetchTgBatchCount 失败，TG 批数设为 0:", e);
      return 0;
    }
  }

  // 继续搜索（从暂停处继续，与 performParallelSearch 同一套任务流）
  async function continueSearch(options: SearchOptions): Promise<void> {
    if (!state.value.paused || !state.value.searched) return;

    setPaused(false);
    setDeepLoading(true);

    // 累进：继续搜索允许再收集一轮结果（50→100→150…）
    maxResultsThreshold += MAX_RESULTS_PER_ROUND;
    autoPausedAtLimit.value = false;

    const startFrom = pausedAtTaskIndex;
    try {
      await performParallelSearch(
        options,
        searchSeq,
        startFrom,
        state.value.merged,
        lastTotalTgBatches
      );
    } catch (error) {
      // 忽略错误
    } finally {
      pausedAtTaskIndex = 0;
      setDeepLoading(false);
      // 自动暂停（达上限）时保持 loading，让"继续"按钮仍可用
      if (!state.value.paused) {
        setLoading(false);
      }
    }
  }
  /** 创建带 AbortController 的搜索任务（插件或 TG 批次） */
  function createSearchTask(
    apiBase: string,
    keyword: string,
    conc: number,
    pluginTimeoutMs: number,
    params: {
      src: "plugin" | "tg";
      plugins?: string;
      /** TG 批次：传 batch 索引 + batchSize，后端从频道清单切片（前端无频道知识） */
      batch?: number;
      batchSize?: number;
    },
    label: string,
    shouldSkip: () => boolean,
    onAuthRequired?: () => void,
    /** 是否允许 TG 深搜（翻更多页补结果）。前端拆批后只有最后一批允许，防误触发爆炸 */
    deep = true
  ): () => Promise<MergedLinks> {
    return async () => {
      if (shouldSkip()) return {};
      const ac = new AbortController();
      activeControllers.push(ac);
      try {
        const extParam = JSON.stringify({
          __plugin_timeout_ms: pluginTimeoutMs,
          __deep_search: deep,
        });
        const q = new URLSearchParams({
          kw: keyword,
          res: "merged_by_type",
          src: params.src,
          conc: String(conc),
          ext: extParam,
        });
        if (params.plugins) q.set("plugins", params.plugins);
        if (params.batch != null) {
          q.set("batch", String(params.batch));
          q.set("batchSize", String(params.batchSize || TG_BATCH_SIZE));
        }
        const response = await $fetch<GenericResponse<SearchResponse>>(
          `${apiBase}/search?${q.toString()}`,
          { signal: ac.signal, credentials: "include" } as any
        );
        return extractMergedFromResponse(response.data);
      } catch (error: any) {
        // 主动取消（AbortController.abort）不算失败：
        // ofetch 抛 FetchError 且把 AbortError 包在 cause 链里，需逐层判断
        const isAbort =
          error?.name === "AbortError" ||
          error?.cause?.name === "AbortError" ||
          error?.cause?.cause?.name === "AbortError";
        if (isAbort) return {};
        if (error?.statusCode === 401) onAuthRequired?.();
        devWarn(`${label} search failed:`, error);
        return {};
      } finally {
        const idx = activeControllers.indexOf(ac);
        if (idx >= 0) activeControllers.splice(idx, 1);
      }
    };
  }

  // 并发搜索 - 每个源独立请求，支持从 startFromTaskIndex 断点续跑
  // initialMerged: continueSearch 时传入暂停前已累积的结果，避免覆盖
  // totalTgBatches: 由 performSearch 先 countOnly 拿到（前端无频道知识，后端切片）
  async function performParallelSearch(
    options: SearchOptions,
    mySeq: number,
    startFromTaskIndex = 0,
    initialMerged?: MergedLinks,
    totalTgBatches = 0
  ): Promise<void> {
    const { apiBase, keyword, settings } = options;
    const conc = Math.min(16, Math.max(1, Number(settings.concurrency || 3)));

    const enabledPlugins = settings.enabledPlugins.filter((n) =>
      ALL_PLUGIN_NAMES.includes(n as any)
    );

    // 2026-08-24：前端不再持有频道清单，TG 批数完全由后端通过 countOnly 告知
    if (enabledPlugins.length === 0 && totalTgBatches === 0) {
      setError("请先在设置中选择至少一个搜索来源");
      return;
    }

    // 收集所有搜索任务
    const searchTasks: Array<() => Promise<MergedLinks>> = [];

    const shouldSkip = () => mySeq !== searchSeq || state.value.paused;
    const onAuth = options.onAuthRequired;

    // 为每个插件创建独立的搜索任务
    for (const plugin of enabledPlugins) {
      searchTasks.push(
        createSearchTask(
          apiBase,
          keyword,
          conc,
          settings.pluginTimeoutMs,
          { src: "plugin", plugins: plugin },
          `Plugin ${plugin}`,
          shouldSkip,
          onAuth
        )
      );
    }

    // 为 TG 批次创建搜索任务（每批 batchSize 个频道作为一个任务）：
    // 2026-08-24 频道零落地：前端只传批次号 batch=N，后端从 defaultChannels 切片抓取
    // 服务端单请求只等这一批（2 频道）抓完就返回 → "边搜边出"更细粒度
    for (let i = 0; i < totalTgBatches; i++) {
      const isLastBatch = i === totalTgBatches - 1;
      searchTasks.push(
        createSearchTask(
          apiBase,
          keyword,
          conc,
          settings.pluginTimeoutMs,
          { src: "tg", batch: i, batchSize: TG_BATCH_SIZE },
          `TG batch ${i}`,
          shouldSkip,
          onAuth,
          // 深搜只允许最后一批触发，避免每批"结果<3"误触发翻页爆炸
          isLastBatch
        )
      );
    }

    // 使用 p-limit 控制并发数
    const pLimit = (await import('p-limit')).default;
    const limit = pLimit(conc);

    // 并发执行所有任务，哪个先返回就立即合并展示，不等待其它
    let currentMerged: MergedLinks = initialMerged ? { ...initialMerged } : {};

    const tasksToSchedule =
      startFromTaskIndex > 0 ? searchTasks.slice(startFromTaskIndex) : searchTasks;
    const limitedTasks = tasksToSchedule.map((task) => limit(task));

    devLog(
      '[performParallelSearch] 开始执行',
      limitedTasks.length,
      '个任务',
      startFromTaskIndex > 0 ? `(从第 ${startFromTaskIndex + 1} 个续跑)` : ''
    );

    let completedCount = startFromTaskIndex;
    parallelCompletedCount = startFromTaskIndex;

    // 每个任务完成即立刻合并展示，不等其它任务
    const totalTaskCount = tasksToSchedule.length;
    const processTask = (result: MergedLinks) => {
      if (mySeq !== searchSeq || state.value.paused) return;
      if (Object.keys(result).length > 0) {
        currentMerged = mergeMergedByType(currentMerged, result);
        setMerged(currentMerged);
        setTotal(
          Object.values(currentMerged).reduce(
            (sum, arr) => sum + (arr?.length || 0),
            0
          )
        );
        devLog('[performParallelSearch] 有数据即展示，当前总数:', Object.values(currentMerged).reduce((s, a) => s + a.length, 0));
      }
      completedCount++;
      parallelCompletedCount = completedCount;

      // 结果达到本轮上限且还有剩余任务 → 自动暂停：
      // 停止剩余请求（进行中 abort，排队中跳过），省服务器资源；用户点"继续"再搜下一轮
      if (completedCount < totalTaskCount) {
        const curTotal = Object.values(currentMerged).reduce(
          (sum, arr) => sum + (arr?.length || 0),
          0
        );
        if (curTotal >= maxResultsThreshold) {
          autoPausedAtLimit.value = true;
          setPaused(true);
          pausedAtTaskIndex = completedCount;
          cancelActiveRequests();
        }
      }
    };

    const wrapped = limitedTasks.map((limitedTask) =>
      limitedTask
        .then((result) => {
          processTask(result);
          return result;
        })
        .catch((err) => {
          devError('[performParallelSearch] 任务错误:', err);
        })
    );

    await Promise.all(wrapped);
    devLog('[performParallelSearch] 所有任务完成');
  }

  // 主搜索函数
  async function performSearch(options: SearchOptions): Promise<void> {
    const { keyword, settings } = options;

    // 验证
    if (!keyword || keyword.trim().length === 0) {
      setError("请输入搜索关键词");
      return;
    }

    const enabledPlugins = settings.enabledPlugins.filter((n) =>
      ALL_PLUGIN_NAMES.includes(n as any)
    );

    // iOS Safari 兼容性：确保输入框失去焦点
    if (
      typeof window !== "undefined" &&
      document.activeElement instanceof HTMLInputElement
    ) {
      document.activeElement.blur();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // 重置状态
    setLoading(true);
    setError("");
    setSearched(true);
    setElapsedMs(0);
    setTotal(0);
    setMerged({});
    setDeepLoading(false);

    const mySeq = ++searchSeq;
    const start = performance.now();

    try {
      // 2026-08-24 频道零落地：先问后端"TG 有 N 批"（响应只有数字，无频道名），
      // 再用 N 个 batch 任务去并发抓取；keyword 变化时重新 countOnly。
      if (lastCountedKeyword !== keyword) {
        lastTotalTgBatches = await fetchTgBatchCount(options.apiBase, keyword);
        lastCountedKeyword = keyword;
      }

      // 并行搜索 - 每个源独立请求，实时更新
      await performParallelSearch(options, mySeq, 0, undefined, lastTotalTgBatches);

      if (mySeq !== searchSeq) return;
    } catch (error: any) {
      setError(error?.data?.message || error?.message || "请求失败");
    } finally {
      setElapsedMs(Math.round(performance.now() - start));
      // 如果暂停了，保持 loading 状态，只取消 deepLoading
      if (!state.value.paused) {
        setLoading(false);
      }
      setDeepLoading(false);
    }
  }

  // 重置搜索
  function resetSearch(): void {
    cancelActiveRequests();
    searchSeq++;
    maxResultsThreshold = MAX_RESULTS_PER_ROUND;
    autoPausedAtLimit.value = false;
    setLoading(false);
    setDeepLoading(false);
    setPaused(false);
    setError("");
    setSearched(false);
    setElapsedMs(0);
    setTotal(0);
    setMerged({});
  }

  // 复制链接
  async function copyLink(url: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(url);
      return true;
    } catch {
      return false;
    }
  }

  // 响应式状态
  const loading = computed(() => state.value.loading);
  const deepLoading = computed(() => state.value.deepLoading);
  const paused = computed(() => state.value.paused);
  const error = computed(() => state.value.error);
  const searched = computed(() => state.value.searched);
  const elapsedMs = computed(() => state.value.elapsedMs);
  const total = computed(() => state.value.total);
  const merged = computed(() => state.value.merged);
  const hasResults = computed(() => Object.keys(state.value.merged).length > 0);

  return {
    state,
    loading,
    deepLoading,
    paused,
    error,
    searched,
    elapsedMs,
    total,
    merged,
    hasResults,
    autoPausedAtLimit: computed(() => autoPausedAtLimit.value),
    performSearch,
    resetSearch,
    copyLink,
    cancelActiveRequests,
    pauseSearch,
    continueSearch,
  };
}
