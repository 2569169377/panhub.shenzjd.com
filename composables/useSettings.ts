import type { Ref } from "vue";
import { DEFAULT_USER_SETTINGS } from "~/config/plugins";
import channelsConfig from "~/config/channels.json";

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

function getDefaultSettings(defaultTgChannels: string[]): UserSettings {
  return {
    enabledTgChannels: [...defaultTgChannels],
    enabledPlugins: [...DEFAULT_USER_SETTINGS.enabledPlugins],
    concurrency: DEFAULT_USER_SETTINGS.concurrency,
    pluginTimeoutMs: DEFAULT_USER_SETTINGS.pluginTimeoutMs,
  };
}

/**
 * 用户设置（服务端默认下发版）。
 *
 * 2026-08-21：设置面板已移除 —— 频道/插件信息是核心资产，
 * 未来由服务端接口与广告一起下发；客户端不再提供可配置入口，
 * 也不再读取 localStorage 中的历史自定义配置（老用户配置立即失效，
 * 搜索恒使用默认频道 + 全部插件）。
 */
export function useSettings(): UseSettingsReturn {
  const config = useRuntimeConfig();

  const defaultTgChannels = computed(() => {
    const configChannels = (config.public as any)?.tgDefaultChannels;
    if (Array.isArray(configChannels) && configChannels.length > 0) {
      return configChannels;
    }
    return channelsConfig.defaultChannels;
  });

  // 使用 Nuxt useState 替代模块级单例，SSR 安全
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
