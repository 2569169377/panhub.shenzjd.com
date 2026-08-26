import { defineEventHandler, readBody, sendError, createError } from "h3";

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
import { isSearchRateLimited } from "../utils/entryRateLimit";
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
  // IP 黑名单拦截（2026-08-24）：累积到阈值的攻击源 24h 内拒绝所有搜索请求
  const ip = getClientIp(event);
  if (await getOrCreateBotDefenseService().isBlocked(ip)) {
    // 2026-08-25 降噪：命中即 403，无需逐条 warn（已拉黑 IP 的反复探测只会刷日志）
    loggers.search.debug(`拦截黑名单 IP`, { ip, method: event.method, path: event.path });
    throw createError({ statusCode: 403, statusMessage: "ip blocked" });
  }
  // 搜索入口 IP 频控（2026-08-25）：60s 内超过阈值（默认 30 次）→ 429
  if (await isSearchRateLimited(ip)) {
    throw createError({ statusCode: 429, statusMessage: "too many requests" });
  }
  // 爬虫/脚本 UA 直接 403，不执行搜索（防刷词持续占用服务器资源）
  requireHumanOrCredential(event);
  // 微信关注公众号登录态校验（恒强制，本地 dev 放行）
  await requireWxAuth(event);
  const config = useRuntimeConfig();
  // 确保频道配置已加载（Turso 加密配置 → 解密缓存），幂等、带 TTL
  await getChannelConfigService().ensureLoaded();
  const service = getOrCreateSearchService(config);
  const body = (await readBody<SearchRequest>(event)) || ({} as SearchRequest);

  const kw = (body.kw || "").trim();
  if (!kw) {
    return sendError(
      event,
      createError({ statusCode: 400, statusMessage: "kw is required" })
    );
  }

  // 记录搜索词（2026-08-22：只要搜索就记录，便于排查）。
  // 防刷由入口 requireHumanOrCredential 承担（bot UA 403），本层不再过滤。
  // 2026-08-25：附带 openid（由 requireWxAuth 解出存
  // event.context），供 search_log 明细关联"谁搜了什么"
  await recordSearchTerm(
    kw,
    ip,
    ((event.context as Record<string, any>)?.__wxAuthOpenid as string) || ""
  );

  body.channels = parseList(body.channels);
  body.plugins = parseList(body.plugins);
  body.cloud_types = parseList(body.cloud_types);

  if (!body.res || body.res === "merge") body.res = "merged_by_type";
  if (!body.src) body.src = "all";
  if (body.src === "tg") body.plugins = undefined;
  else if (body.src === "plugin") body.channels = undefined;

  // countOnly：前端"问后端有 N 批"，不实际搜索，立即返回（零落地）
  const requestedChannels = body.channels;
  const { batch, batchSize, countOnly } = parseBatchQuery(body as any);
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

  // 决定本次要搜的频道（channels 显式 > batch 切片 > 一次性全量）
  const allChannels = getChannelConfigService().getSnapshot().defaultChannels;
  body.channels =
    requestedChannels && requestedChannels.length > 0
      ? requestedChannels
      : batch != null
      ? sliceBatchChannels(allChannels, batch, batchSize)
      : allChannels;

  const signal = getClientAbortSignal(event);

  const { response: result, warnings } = await service.searchWithWarnings(
    kw,
    body.channels,
    body.conc,
    !!body.refresh,
    body.res,
    body.src,
    body.plugins,
    body.cloud_types,
    body.ext || {},
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
