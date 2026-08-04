import { SearchService, type SearchServiceOptions } from "./searchService";
import {
  PluginManager,
  registerGlobalPlugin,
  type AsyncSearchPlugin,
} from "../plugins/manager";
import { loggers } from "../utils/logger";
// NOTE: 8 dead plugins removed on 2026-07-06 based on log analysis:
//   hunhepan   - 3 APIs all dead (504/414/404)
//   jikepan    - source down (CF 522)
//   labi       - domain expired
//   qupansou   - search upstream 502
//   duoduo     - Cloudflare JS challenge blocks all HTTP scraping
//   thepiratebay - mirror URL expired + anti-scrape
//   panta      - overseas IP unreachable (likely blocked)
//   xuexizhinan - small site offline
// See: data/panhub.shenzjd.com-20260706090537.log analysis
// NOTE: 5 个死插件于 2026-08-04 删除（无引用）：zhizhen / hdr4k / muou / huban / shandian
import { PansearchPlugin } from "../plugins/pansearch";
import { NyaaPlugin } from "../plugins/nyaa";
import { MelostPlugin } from "../plugins/melost";
import { Quark4kPlugin } from "../plugins/quark4k";
import { OugePlugin } from "../plugins/ouge";
import { WanouPlugin } from "../plugins/wanou";
import { YunsoPlugin } from "../plugins/yunso";
import { U3c3Plugin } from "../plugins/u3c3";

const SERVICE_CONTEXT_KEY = "__panhub_search_service__";

/**
 * 安全注册插件（隔离闸 A）：单个插件构造或初始化抛错只跳过该插件，
 * 不会让整个服务启不起来。这是“新增插件有问题也不影响现有服务”的第一道闸。
 */
function safeRegister(label: string, factory: () => AsyncSearchPlugin) {
  try {
    const plugin = factory();
    registerGlobalPlugin(plugin);
  } catch (err) {
    loggers.plugin.error("插件注册失败，已跳过（不影响其他插件）", {
      plugin: label,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * 创建插件管理器并注册所有可用插件
 */
function createPluginManager(): PluginManager {
  const pm = new PluginManager();
  // 仅注册稳定可用的插件；新增插件统一走 safeRegister，单点失败不影响整体
  safeRegister("pansearch", () => new PansearchPlugin());
  safeRegister("nyaa", () => new NyaaPlugin());
  safeRegister("melost", () => new MelostPlugin());
  safeRegister("quark4k", () => new Quark4kPlugin());
  safeRegister("ouge", () => new OugePlugin());
  safeRegister("wanou", () => new WanouPlugin());
  safeRegister("yunso", () => new YunsoPlugin());
  safeRegister("u3c3", () => new U3c3Plugin());
  pm.registerAllGlobalPlugins();
  return pm;
}

/**
 * 创建搜索服务选项
 */
function createServiceOptions(runtimeConfig: any): SearchServiceOptions {
  return {
    priorityChannels: runtimeConfig.priorityChannels || [],
    defaultChannels: runtimeConfig.defaultChannels || [],
    defaultConcurrency: runtimeConfig.defaultConcurrency || 10,
    pluginTimeoutMs: runtimeConfig.pluginTimeoutMs || 15000,
    cacheEnabled: !!runtimeConfig.cacheEnabled,
    cacheTtlMinutes: runtimeConfig.cacheTtlMinutes || 30,
  };
}

/**
 * 获取或创建搜索服务实例
 * 使用 Nitro 上下文存储，支持测试时重置
 */
export function getOrCreateSearchService(runtimeConfig: any): SearchService {
  // 尝试从 Nitro 上下文获取
  const context = (globalThis as any)[SERVICE_CONTEXT_KEY];
  if (context?.service) {
    return context.service;
  }

  // 创建新实例
  const options = createServiceOptions(runtimeConfig);
  const pluginManager = createPluginManager();
  const service = new SearchService(options, pluginManager);

  // 存储到上下文
  (globalThis as any)[SERVICE_CONTEXT_KEY] = { service, options, pluginManager };
  return service;
}

/**
 * 重置搜索服务实例（仅用于测试）
 */
export function resetSearchService(): void {
  delete (globalThis as any)[SERVICE_CONTEXT_KEY];
}

/**
 * 获取搜索服务统计信息（用于监控）
 */
export function getSearchServiceStats(): { exists: boolean; options?: SearchServiceOptions } {
  const context = (globalThis as any)[SERVICE_CONTEXT_KEY];
  if (!context) {
    return { exists: false };
  }
  return {
    exists: true,
    options: context.options,
  };
}
