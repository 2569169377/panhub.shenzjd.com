import { defineEventHandler, getQuery, createError, createEventStream } from "h3";
import type { H3Event } from "h3";
import { requireSearchAuth, requireHumanOrCredential, requireWxAuth } from "../utils/requireAuth";
import { parseList } from "../utils/parseQuery";
import { recordSearchTerm } from "../utils/recordSearchTerm";
import { getClientIp } from "../middleware/rateLimiter";
import { getOrCreateBotDefenseService } from "../core/services/botDefense";
import { getOrCreateSearchService } from "../core/services";
import { getChannelConfigService } from "../core/services/channelConfigService";
import { loggers } from "../core/utils/logger";
import { sliceBatchChannels } from "../core/utils/batchChannels";
import type { SearchRequest, MergedLinks } from "../core/types/models";

/**
 * SSE 搜索流端点（2026-08-24 用户拍板架构改造）
 *
 * 背景：一次搜索原本 = 前端并发 35+ 个子请求（countOnly + 各 batch + 各插件），
 * 每个子请求都触发 wx-auth 校验 → 打爆限流。频道已零落地到后端，前端
 * 不再需要知道批次。
 *
 * 本端点：**1 个 SSE 连接承载整个搜索**——
 * - 建立连接时只做 1 次 wx-auth 校验（复用 10s 缓存）
 * - 后端把 TG 频道按 batchSize 切片，受控并发逐批抓取
 * - 每完成一批 push 一个 chunk 事件（增量结果），前端边收边渲染
 * - 全部完成 push done 事件（汇总 total）
 * - 频道名不出现在任何事件里（零落地保持）
 *
 * 事件协议（data 为 JSON 字符串）：
 *   event: chunk  data: {"done":N,"total":M,"merged":{type:[...]}}
 *   event: done   data: {"total":N,"warnings":[...]}
 *   event: error  data: {"message":"..."}
 *
 * 客户端断开：eventStream.onClosed → abort 内部搜索 → close
 */

/** 服务端每批抓取的频道数（TG 频道限流友好 + 批次数量可控） */
const TG_BATCH_SIZE = 6;
/** 后端批次并发数（受控，避免一次拉起全部批次） */
const TG_BATCH_CONCURRENCY = 4;
/** 客户端断开后，后端最多再等多久清理（防止挂起的 fetch 无限占资源） */
const CLOSE_GRACE_MS = 2_000;

export default defineEventHandler(async (event: H3Event) => {
  // ---- 入口鉴权（只做一次）----
  requireSearchAuth(event);
  const ip = getClientIp(event);
  if (await getOrCreateBotDefenseService().isBlocked(ip)) {
    loggers.search.warn(`拦截黑名单 IP 搜索请求`, { ip, method: event.method, path: event.path });
    throw createError({ statusCode: 403, statusMessage: "ip blocked" });
  }
  requireHumanOrCredential(event);
  await requireWxAuth(event);

  const config = useRuntimeConfig();
  await getChannelConfigService().ensureLoaded();
  const service = getOrCreateSearchService(config);
  const q = getQuery(event);

  const kw = ((q.kw as string) || "").trim();
  if (!kw) {
    throw createError({ statusCode: 400, statusMessage: "kw is required" });
  }
  if (kw.length > 200) {
    throw createError({ statusCode: 400, statusMessage: "kw too long (max 200)" });
  }

  await recordSearchTerm(kw, ip);

  let ext: Record<string, any> | undefined;
  const extStr = (q.ext as string | undefined)?.trim();
  if (extStr) {
    if (extStr === "{}") ext = {};
    else {
      try {
        ext = JSON.parse(extStr);
      } catch {
        throw createError({ statusCode: 400, statusMessage: "invalid ext json" });
      }
    }
  }

  const allChannels = getChannelConfigService().getSnapshot().defaultChannels;
  const src = (q.src as any) || "all";
  const plugins = parseList(q.plugins);
  const cloudTypes = parseList(q.cloud_types);
  const res = (q.res as any) || "merged_by_type";
  const refresh = String(q.refresh).trim() === "true";

  const conc = (() => {
    const n = q.conc ? parseInt(String(q.conc), 10) : NaN;
    return Number.isFinite(n) && n >= 1 && n <= 16 ? n : undefined;
  })();

  const req: SearchRequest = {
    kw,
    channels: undefined,
    conc,
    refresh,
    res,
    src,
    plugins,
    cloud_types: cloudTypes,
    ext,
  };
  if (req.src === "tg") req.plugins = undefined;
  else if (req.src === "plugin") req.channels = undefined;
  if (!req.res || req.res === "merge") req.res = "merged_by_type";

  // ---- 建立 SSE 流 ----
  const stream = createEventStream(event);
  const abortController = new AbortController();
  const signal = abortController.signal;

  stream.onClosed(() => {
    // 客户端断开：先给内部搜索一个 grace 期让它自然收尾，再强制 abort
    setTimeout(() => abortController.abort(), CLOSE_GRACE_MS);
  });

  const push = (eventName: string, data: unknown): Promise<void> =>
    stream.push({ event: eventName, data: JSON.stringify(data) });

  // 后台执行搜索并逐批推送；主 handler 返回 stream.send() 保持连接
  void (async () => {
    try {
      // 任务统一进并发池：TG 批次 + 各插件源，谁先完成谁先 push chunk
      // → 前端"边搜边出"，不等所有任务完成
      const pLimit = (await import("p-limit")).default;
      // 按类型分两个并发池（TG_BATCH_CONCURRENCY 各自一份）：
      // 插件池和 TG 池互相独立，避免慢的 TG 占满限流槽位"堵死"插件
      // （生产 TG 通道很快，dev 环境 TG 受限超时，会让插件晚到 9+ 秒）
      const tgLimit = pLimit(TG_BATCH_CONCURRENCY);
      const pluginLimit = pLimit(TG_BATCH_CONCURRENCY);

      const totalBatches = Math.max(1, Math.ceil(allChannels.length / TG_BATCH_SIZE));
      // src=all 或 src=plugin 时都跑插件（与 search.get.ts 行为一致）
      const enabledPlugins =
        (src === "all" || src === "plugin") && plugins && plugins.length > 0
          ? plugins
          : [];

      // 构建任务列表
      interface Task {
        type: "tg" | "plugin";
        index: number;
      }
      const tgTasks: Task[] = [];
      for (let i = 0; i < totalBatches; i++) tgTasks.push({ type: "tg", index: i });
      const pluginTasks: Task[] = [];
      for (let i = 0; i < enabledPlugins.length; i++)
        pluginTasks.push({ type: "plugin", index: i });

      const total = tgTasks.length + pluginTasks.length;
      let done = 0;
      let acc: MergedLinks = {};
      const warnings: string[] = [];

      const runTask = async (task: Task) => {
        if (signal.aborted) return;
        try {
          let batchMerged: MergedLinks = {};
          if (task.type === "tg") {
            const batchChannels = sliceBatchChannels(
              allChannels,
              task.index,
              TG_BATCH_SIZE
            );
            if (batchChannels.length > 0) {
              const { response, warnings: w } = await service.searchWithWarnings(
                kw,
                batchChannels,
                conc,
                refresh,
                "merged_by_type",
                "tg",
                undefined,
                undefined,
                // 深搜只允许最后一批触发（防每批都翻页 CPU 炸弹）
                { ...(ext || {}), __deep_search: task.index === totalBatches - 1 },
                signal
              );
              if (w.length > 0) warnings.push(...w);
              if (response.merged_by_type) {
                batchMerged = response.merged_by_type;
              }
            }
          } else {
            // 单个插件独立成任务（plugins 传 [name] 让 searchPlugins 内部只跑这个）
            const { response, warnings: w } = await service.searchWithWarnings(
              kw,
              undefined,
              conc,
              refresh,
              "merged_by_type",
              "plugin",
              [enabledPlugins[task.index]],
              cloudTypes,
              ext || {},
              signal
            );
            if (w.length > 0) warnings.push(...w);
            if (response.merged_by_type) {
              batchMerged = response.merged_by_type;
            }
          }
          if (Object.keys(batchMerged).length > 0) {
            acc = mergeMergedByType(acc, batchMerged);
          }
        } catch (err) {
          loggers.search.warn(`SSE ${task.type} 任务失败`, {
            keyword: kw,
            task,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        done++;
        if (!signal.aborted) {
          // 累计快照推 chunk：前端简单 setMerged(acc) 即可，
          // 避免增量协议下"丢/重"的复杂合并逻辑
          await push("chunk", {
            done,
            total,
            merged: acc,
          });
        }
      };

      // 并发执行：TG 池 + 插件池互相独立，慢的 TG 不会"堵"插件
      await Promise.all([
        ...tgTasks.map((task) => tgLimit(() => runTask(task))),
        ...pluginTasks.map((task) => pluginLimit(() => runTask(task))),
      ]);

      // 汇总事件：done 带 merged 作为最终兜底（即使 chunk 全部空，
      // 插件结果也能保证送到前端）
      const finalTotal = Object.values(acc).reduce(
        (sum, arr) => sum + arr.length,
        0
      );
      if (!signal.aborted) {
        await push("done", {
          total: finalTotal,
          warnings,
          pluginCount: enabledPlugins.length,
          merged: acc,
        });
      }
    } catch (err) {
      loggers.search.error("SSE 搜索异常", {
        keyword: kw,
        error: err instanceof Error ? err.message : String(err),
      });
      if (!signal.aborted) {
        await push("error", {
          message: err instanceof Error ? err.message : "搜索异常",
        });
      }
    } finally {
      await stream.close();
    }
  })();

  return stream.send();
});

/** 按 url 去重合并（与前端 utils/mergeMergedByType 同逻辑，供后端增量累加） */
function mergeMergedByType(
  target: MergedLinks,
  incoming: MergedLinks
): MergedLinks {
  const out: MergedLinks = { ...target };
  for (const type of Object.keys(incoming)) {
    const existed = out[type] || [];
    const next = incoming[type] || [];
    const seen = new Set<string>(existed.map((x) => x.url));
    const mergedArr = [...existed];
    for (const item of next) {
      if (!seen.has(item.url)) {
        seen.add(item.url);
        mergedArr.push(item);
      }
    }
    out[type] = mergedArr;
  }
  return out;
}
