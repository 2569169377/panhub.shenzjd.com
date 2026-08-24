import { defineEventHandler, getQuery, sendError, createError } from "h3";

/** 从 H3 event 中提取客户端断开信号（兼容 h3 无 getAbortSignal 的版本） */
function getClientAbortSignal(event: any): AbortSignal | undefined {
  // 优先使用 h3 原生能力（若未来版本支持）
  if (typeof event._signal === "object" && event._signal instanceof AbortSignal) {
    return event._signal;
  }
  // 回退：监听 node req 的 close 事件
  const req = event.node?.req;
  if (req && typeof req.on === "function") {
    const controller = new AbortController();
    req.on("close", () => {
      if (req.destroyed || req.writableEnded === false && req.readableEnded) {
        controller.abort();
      }
    });
    return controller.signal;
  }
  return undefined;
}
import { requireSearchAuth, requireHumanOrCredential, requireWxAuth } from "../utils/requireAuth";
import { parseList } from "../utils/parseQuery";
import { recordSearchTerm } from "../utils/recordSearchTerm";
import { getClientIp } from "../middleware/rateLimiter";
import { getOrCreateBotDefenseService } from "../core/services/botDefense";
import { getOrCreateSearchService } from "../core/services";
import { getChannelConfigService } from "../core/services/channelConfigService";
import { loggers } from "../core/utils/logger";
import {
  buildBatchPlan,
  sliceBatchChannels,
  parseBatchQuery,
} from "../core/utils/batchChannels";
import type { GenericResponse, SearchRequest } from "../core/types/models";

export default defineEventHandler(async (event) => {
  requireSearchAuth(event);
  // IP 黑名单拦截（2026-08-24 用户拍板：累积到阈值的攻击源 24h 内拒绝所有搜索请求）
  // 放在 UA 校验之前：黑名单 IP 多半已多次触发拦截，连 UA 检查都跳过直接 403
  const ip = getClientIp(event);
  if (await getOrCreateBotDefenseService().isBlocked(ip)) {
    loggers.search.warn(`拦截黑名单 IP 搜索请求`, { ip, method: event.method, path: event.path });
    throw createError({ statusCode: 403, statusMessage: "ip blocked" });
  }
  // 爬虫/脚本 UA 直接 403，不执行搜索（防刷词持续占用服务器资源）
  requireHumanOrCredential(event);
  // 微信关注公众号登录态校验（WX_AUTH_ENFORCE=1 时启用，实时校验不缓存）
  await requireWxAuth(event);
  const config = useRuntimeConfig();
  // 确保频道配置已加载（Turso 加密配置 → 解密缓存），幂等、带 TTL
  await getChannelConfigService().ensureLoaded();
  const service = getOrCreateSearchService(config);
  const q = getQuery(event);

  const kw = ((q.kw as string) || "").trim();
  if (!kw) {
    return sendError(
      event,
      createError({ statusCode: 400, statusMessage: "kw is required" })
    );
  }
  if (kw.length > 200) {
    return sendError(
      event,
      createError({ statusCode: 400, statusMessage: "kw too long (max 200)" })
    );
  }

  // 记录搜索词（2026-08-22：只要搜索就记录，便于排查）。
  // 防刷由入口 requireHumanOrCredential 承担（bot UA 403），本层不再过滤。
  await recordSearchTerm(kw, ip);

  let ext: Record<string, any> | undefined;
  const extStr = (q.ext as string | undefined)?.trim();
  if (extStr) {
    if (extStr === "{}") ext = {};
    else {
      try {
        ext = JSON.parse(extStr);
      } catch (e: any) {
        return sendError(
          event,
          createError({
            statusCode: 400,
            statusMessage: "invalid ext json",
          })
        );
      }
    }
  }

  const requestedChannels = parseList(q.channels);
  const { batch, batchSize, countOnly } = parseBatchQuery(q as any);

  // countOnly：前端用于"问后端有 N 批"，不实际搜索，立即返回
  // （返回的只是数字，不含频道名，零落地）
  if (countOnly) {
    const allChannels = getChannelConfigService().getSnapshot().defaultChannels;
    const plan = buildBatchPlan(allChannels, batchSize);
    const resp: GenericResponse<typeof plan> = {
      code: 0,
      message: "ok",
      data: plan,
    };
    return resp;
  }

  // 决定本次要搜的频道（优先级：前端显式 channels > batch 切片 > 一次性全量）
  // 切片逻辑在 batchChannels.ts，便于测试
  const allChannels = getChannelConfigService().getSnapshot().defaultChannels;
  const effChannels: string[] =
    requestedChannels && requestedChannels.length > 0
      ? requestedChannels
      : batch != null
      ? sliceBatchChannels(allChannels, batch, batchSize)
      : allChannels;

  const req: SearchRequest = {
    kw,
    channels: effChannels,
    conc: (() => {
      const n = q.conc ? parseInt(String(q.conc), 10) : NaN;
      return Number.isFinite(n) && n >= 1 && n <= 16 ? n : undefined;
    })(),
    refresh: String(q.refresh).trim() === "true",
    res: (q.res as any) || "merged_by_type",
    src: (q.src as any) || "all",
    plugins: parseList(q.plugins),
    cloud_types: parseList(q.cloud_types),
    ext,
  };

  if (req.src === "tg") req.plugins = undefined;
  else if (req.src === "plugin") req.channels = undefined;
  if (!req.res || req.res === "merge") req.res = "merged_by_type";

  const signal = getClientAbortSignal(event);

  const { response: result, warnings } = await service.searchWithWarnings(
    req.kw,
    req.channels,
    req.conc,
    !!req.refresh,
    req.res,
    req.src,
    req.plugins,
    req.cloud_types,
    req.ext || {},
    signal
  );

  const resp: GenericResponse<typeof result> = {
    code: 0,
    message: warnings.length > 0 ? "partial_success" : "success",
    data: result,
  };

  if (warnings.length > 0) {
    (resp as any).warnings = warnings;
  }

  return resp;
});
