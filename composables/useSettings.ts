import type { Ref } from "vue";
import { DEFAULT_USER_SETTINGS } from "~/config/plugins";

export interface UserSettings {
  enabledTgChannels: string[];
  enabledPlugins: string[];
  concurrency: number;
  pluginTimeoutMs: number;
}

export interface UseSettingsReturn {
  settings: Ref<UserSettings>;
  loadSettings: () => void;
}

function getDefaultSettings(): UserSettings {
  return {
    // 2026-08-24：频道清单彻底移出前端，前端不再持有。
    // 搜索时由后端从 channelConfigService 切片（前端只传批次号），
    // 详见 server/core/utils/batchChannels.ts。
    enabledTgChannels: [],
    enabledPlugins: [...DEFAULT_USER_SETTINGS.enabledPlugins],
    concurrency: DEFAULT_USER_SETTINGS.concurrency,
    pluginTimeoutMs: DEFAULT_USER_SETTINGS.pluginTimeoutMs,
  };
}

/**
 * 用户设置（服务端下发版）。
 *
 * 2026-08-21：设置面板已移除 —— 频道/插件信息是核心资产，
 * 由服务端接口与广告一起下发；客户端不再提供可配置入口。
 *
 * 2026-08-24：频道清单彻底移出前端（不再经 /api/channels 下发），
 * 搜索时分批逻辑也由后端负责（前端只发"第几批"），前端永远见不到
 * 完整频道清单。enabledTgChannels 字段保留为兼容历史，但永远空数组。
 */
export function useSettings(): UseSettingsReturn {
  const settings = useState<UserSettings>("user-settings", () => getDefaultSettings());

  // 保留函数签名以兼容现有调用方；不再做任何本地持久化
  function loadSettings(): void {}

  return {
    settings,
    loadSettings,
  };
}
