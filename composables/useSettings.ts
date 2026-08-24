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

/** /api/channels 下发的频道配置结构 */
export interface ChannelConfigPayload {
  version: number;
  priorityChannels: string[];
  defaultChannels: string[];
}

function getDefaultSettings(defaultTgChannels: string[]): UserSettings {
  return {
    enabledTgChannels: [...defaultTgChannels],
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
 * 2026-08-24：频道清单彻底移出仓库/前端 bundle，改为 SSR 时
 * useFetch('/api/channels') 从服务端拉取（服务端从 Turso 解密缓存）。
 * 前端仍需要频道名用于分批搜索，但抓取/解析逻辑全在服务器。
 */
export function useSettings(): UseSettingsReturn {
  const { data } = useFetch<ChannelConfigPayload>("/api/channels");

  const defaultTgChannels = computed(() => {
    const channels = data.value?.defaultChannels;
    return Array.isArray(channels) && channels.length > 0 ? channels : [];
  });

  // 使用 Nuxt useState 替代模块级单例，SSR 安全
  // （SSR 端 useFetch 已 resolve，defaultTgChannels 有值；客户端 hydration 复用）
  const settings = useState<UserSettings>("user-settings", () =>
    getDefaultSettings(defaultTgChannels.value)
  );

  // 保留函数签名以兼容现有调用方；不再做任何本地持久化
  function loadSettings(): void {}

  return {
    settings,
    loadSettings,
  };
}
