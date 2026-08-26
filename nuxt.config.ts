// https://nuxt.com/docs/api/configuration/nuxt-config
import channelsConfig from "./config/channels.json";

export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  devtools: { enabled: false },
  css: ["~/assets/css/admin-shared.css"],
  devServer: {
    port: 4000,
  },
  app: {
    head: {
      htmlAttrs: { lang: "zh-CN" },
      title: "PanHub · 全网最全的网盘搜索",
      titleTemplate: "%s · PanHub",
      meta: [
        {
          name: "viewport",
          content:
            "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover",
        },
        {
          name: "description",
          content:
            "PanHub：聚合阿里云盘、夸克、百度网盘、115、迅雷等平台的全网最全网盘搜索工具，实时检索分享资源，快速、高效。",
        },
        {
          name: "keywords",
          content:
            "网盘搜索, 阿里云盘, 夸克, 百度网盘, 115, 迅雷, 资源搜索, 盘搜, panhub, 网盘聚合搜索",
        },
        { name: "theme-color", content: "#111111" },
        { property: "og:type", content: "website" },
        { property: "og:site_name", content: "PanHub" },
      ],
      link: [{ rel: "icon", type: "image/x-icon", href: "/favicon.ico" }],
    },
  },
  nitro: {
    // 根据环境变量动态选择部署预设
    preset: process.env.VERCEL
      ? "vercel"
      : process.env.NITRO_PRESET || "node-server",
    // Vercel serverless function 最大执行时间（Pro: 60s, Hobby: 10s）
    vercel: {
      functions: {
        maxDuration: 60,
      },
    },
  },
  routeRules: {
    // 热搜接口不缓存，否则 POST 写入后 GET 仍返回旧数据
    "/api/hot-searches": { swr: false, cache: false },
    // 热搜日历含"今日搜索次数"等实时统计，禁缓存避免滞后
    "/api/hot-calendar": { swr: false, cache: false },
    // 豆瓣热搜允许短时缓存（服务端已有 60 分钟 cache）
    "/api/douban-hot": { swr: false, cache: false },
    // 密码门接口不缓存，确保 POST body 正常处理
    "/api/auth/**": { swr: false, cache: false },
    // 搜索接口依赖 Cookie 鉴权，禁止缓存避免 401 被缓存
    "/api/search": { swr: false, cache: false },
    // SSE 搜索流（2026-08-24 架构改造）：长连接逐批推送，禁止缓存
    // （默认 /** swr:3600 会把流缓存成 204 空响应）
    "/api/search.stream": { swr: false, cache: false },
    // 搜索明细管理查询（2026-08-25）：敏感数据 + 需实时看到新增记录，禁缓存
    "/api/search-log": { swr: false, cache: false },
    // IP 黑名单管理查询（2026-08-25）：同样禁缓存——
    // ⚠️ 漏加此条曾导致首次 401 被 /** swr:3600 缓存 1 小时，之后请求
    // 到不了后端，用户有 token 也永远 401（管理页看不到 userinfo 调用）
    "/api/blacklist": { swr: false, cache: false },
    // 链接检测接口需要读 POST body，禁止缓存避免 body 被中间件消费
    "/api/check": { swr: false, cache: false },
    // 图片代理依赖豆瓣，禁止 SWR 缓存避免错误响应被缓存
    "/api/img": { swr: false, cache: false },
    "/**": { swr: 3600 },
  },
  runtimeConfig: {
    // server-only 配置
    searchPassword: process.env.SEARCH_PASSWORD || "",
    // 2026-08-24：频道清单已从仓库/配置移除，改由 ChannelConfigService
    // 从 Turso 加密表拉取（见 server/core/services/channelConfigService.ts），
    // 不再注入 runtimeConfig；前端经 /api/channels 下发获取。
    defaultConcurrency: channelsConfig.defaultConcurrency,
    pluginTimeoutMs: channelsConfig.pluginTimeoutMs,
    cacheEnabled: true,
    cacheTtlMinutes: channelsConfig.cacheTtlMinutes,
    public: {
      apiBase: "/api",
      siteUrl: "https://panhub.shenzjd.com",
      // 前端微信认证开关（默认 "0" = fork 友好软引导）。
      //
      // ⚠️ 必须用 Nuxt 官方运行时覆盖通道 NUXT_PUBLIC_WX_AUTH_ENFORCE，而不是在
      //    构建期读 process.env.WX_AUTH_ENFORCE：
      //    - Nuxt 文档：runtimeConfig.public 由「同名 NUXT_PUBLIC_* 环境变量」在
      //      运行时自动覆盖；SSR 每次请求把新值序列化进 payload，客户端随之生效，
      //      Docker --env-file / 服务器 env / wrangler secret 都能覆盖，无需重建镜像。
      //    - 反例：把默认值写成 process.env.WX_AUTH_ENFORCE 只在「构建时」求值，
      //      CI 构建环境没有 .env → 主站前端也被打成 false（bug），且违背运行覆盖机制。
      //
      // ⚠️ 取值类型坑（本次复盘实证）：Nuxt 环境变量覆盖经 destr 解析——"true" → boolean
      //    true，"1" → number 1（不是字符串）。默认值统一用字符串 "0"（fork 软引导），
      //    主站部署配 NUXT_PUBLIC_WX_AUTH_ENFORCE=1（会被 destr 转成 number 1）。
      //    读取端（useWxAuth.ts）已做宽松四态判断 boolean true / number 1 / string "1" / "true",
      //    避免类型漂移导致主站强制配置静默失效。
      // 取值约定：
      //   1 → 主站强制：未认证搜索时弹窗常驻不可关，前端拦截 + 后端 401 双保险
      //   0 → fork 默认软引导：每个新会话弹一次可关引导（扫码关注公众号，sessionStorage
      //       记一次，标志会话内不再弹），搜索不阻塞、后端也不拦
      // ⚠️ 前端强制必须与后端 WX_AUTH_ENFORCE=1 配套，否则体验断裂（前端放行但后端 401）。
      wxAuthEnforce: "0",
    },
  },
});
