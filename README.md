# PanHub · 全网最全的网盘搜索

> 一个搜索框，搜遍全网网盘资源 —— 即搜即得、聚合去重、免费开源、零广告、轻量部署

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fwu529778790%2Fpanhub.shenzjd.com&project-name=panhub&repository-name=panhub.shenzjd.com)
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wu529778790/panhub.shenzjd.com)
[![Docker Hub](https://img.shields.io/badge/docker-ghcr.io-blue?logo=docker)](https://github.com/wu529778790/panhub.shenzjd.com/pkgs/container/panhub)

**在线体验**：<https://panhub.shenzjd.com>

---

## ✨ 核心特性

### 🔍 智能搜索

- **多源聚合**：同时搜索 Telegram 80+ 频道 + 20+ 第三方插件
- **优先级调度**：高优先级频道优先返回，首屏结果提速 50%+
- **批量并发**：独立配置优先/普通频道并发数，充分利用网络带宽
- **暂停/继续**：搜索过程可随时暂停，断点续跑不丢结果
- **插件熔断**：失败插件自动降级 5 分钟，避免拖慢整体搜索
- **请求超时取消**：AbortController 真正取消超时请求，不泄漏连接
- **智能缓存**：LRU 淘汰 + 内存监控 + 过期清理

### 📊 豆瓣影视榜单

- **12 个分类**：Top250、剧情、喜剧、动作、爱情、科幻、动画、悬疑、犯罪、战争、纪录片、电视剧
- **JSON API 驱动**：使用豆瓣内部 API 获取结构化数据，无需解析 HTML（Top250 除外）
- **24 小时缓存**：每个分类一天只请求一次，减少对豆瓣的压力
- **无限滚动**：滚动到底部自动加载更多内容
- **一键搜索**：点击任意影视，自动发起网盘搜索

### 🔗 链接有效性检测（服务端探活）

- **自动标记失效链接**：搜索结果中的失效链接自动加删除线 + 红色"已失效"角标，需密码的标橙色"需密码"
- **服务端探活**：无需安装任何扩展，服务端直连各网盘匿名分享 API 判定，零安装成本
- **平台适配**：夸克、阿里、百度、115、天翼、迅雷、123、UC、移动云盘
- **分级缓存**：ok 24h / 失效 6h / 需密码 12h，同一链接不重复探活，并发池限流防被网盘接口封禁

### 🔥 热门搜索

- **实时热搜**：展示其他用户搜索词，点击即可搜索
- **数据持久化**：Turso（libSQL，Worker/Docker/本地统一存储，唯一真源）
- **搜索统计**：实时展示热搜榜使用次数

### 🎨 用户体验

- **深色模式**：完整支持深色主题，自动跟随系统偏好
- **响应式设计**：完美适配桌面、平板、手机
- **密码门**：可配置 `SEARCH_PASSWORD`，密码爆破防护（5 次失败锁定）
- **优雅降级**：单个插件/频道失败不影响整体

### 🛡️ 安全与稳定性

- **限流防护**：API 路由限流 + unlock 密码爆破防护
- **SSRF 防护**：图片代理白名单 + URL 严格校验
- **输入校验**：关键词长度限制、并发数范围校验
- **错误处理**：统一的 `createError` 错误响应
- **125+ 测试用例**：核心逻辑全覆盖

---

## 🚀 快速开始

### 方式一：Vercel 一键部署（推荐）

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fwu529778790%2Fpanhub.shenzjd.com&project-name=panhub&repository-name=panhub.shenzjd.com)

点击按钮后 Vercel 会自动：克隆仓库到你的 GitHub 账号 → 检测 Nuxt 框架并配置构建（`npm run build`，Vercel 自动使用 vercel preset）→ 部署。无需手动配置构建命令。

**热搜功能依赖 Turso，必须配置**：部署完成后到 Vercel 项目 **Settings → Environment Variables** 添加：

| 名称 | 值 |
|------|-----|
| `TURSO_URL` | `libsql://<db>-<org>.turso.io` |
| `TURSO_AUTH_TOKEN` | Turso 控制台生成的 Token |

添加后**重新部署一次**（Deployments → Redeploy）即生效。未配置时站点搜索等核心功能正常，热搜接口返回空数据（不报错）。

### 方式二：Cloudflare Workers 一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wu529778790/panhub.shenzjd.com)

点击按钮后 Cloudflare 会自动：克隆仓库到你的 GitHub 账号 → 配置 Workers Builds（每次 push 自动构建部署）。

> **部署配置**：在 Cloudflare 配置页将 **Build command** 设为 `npm run build:cf`（deploy command 会自动检测为 `npx wrangler deploy`）。部署完成后可在 Cloudflare Dashboard 的 **Workers Builds** 中关联仓库生产分支，实现 push 即自动更新。

**热搜功能依赖 Turso，必须配置**：热搜数据统一存 Turso（libSQL，免费档 5 亿行读/月、1000 万行写/月）。配置两步即可启用：

1. 到 [turso.tech](https://turso.tech) 注册并创建数据库，拿到 URL 和 Token
2. 在 Worker 设置中添加两个 Secret（Dashboard → Workers → 你的 Worker → Settings → Variables and Secrets）：

| 名称 | 值 |
|------|-----|
| `TURSO_URL` | `libsql://<db>-<org>.turso.io` |
| `TURSO_AUTH_TOKEN` | Turso 控制台生成的 Token |

> 未配置时站点搜索等核心功能正常，热搜接口返回空数据（不报错，页面表现为无热搜）。本地开发 / Docker 部署在 `.env` 中配置同样的两个变量即可。

### 方式三：Docker 部署

```bash
# 快速启动
docker run --name panhub -p 4000:4000 -d ghcr.io/wu529778790/panhub.shenzjd.com:latest

# 数据持久化（推荐）
mkdir -p /root/panhub/data
docker run -d --name panhub -p 4000:4000 \
  -v /root/panhub/data:/app/data \
  ghcr.io/wu529778790/panhub.shenzjd.com:latest
```

### 方式四：本地开发

```bash
# 安装依赖
npm install

# 开发服务器
npm dev

# 运行测试
npm test

# 构建生产版本
npm build
```

---

## 📖 使用指南

### 搜索流程

1. **输入关键词并回车**开始搜索
2. **快速结果**：优先频道先返回（~50ms）
3. **深度结果**：剩余频道继续加载
4. **自动合并**：结果去重、按时间排序、分类型展示

### 链接有效性检测

搜索结果加载后，服务端自动对当前可见链接探活（异步，不阻塞搜索）：

- 失效链接：红色"已失效"角标 + 删除线
- 需密码链接：橙色"需密码"角标
- 探活结果有分级缓存，同一链接不会重复请求

### 设置面板

右上角设置按钮可配置：

- **插件管理**：启用/禁用第三方搜索插件
- **TG 频道**：配置优先/普通频道列表
- **性能参数**：并发数（1-16）、超时时间（1000-60000ms）

---

## ⚙️ 环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `LOG_LEVEL` | `info` | 日志级别（debug/info/warn/error），支持白名单校验 |
| `NITRO_PRESET` | auto-detect | 部署预设（vercel/cloudflare/node-server） |
| `PORT` | `4000` | 服务端口 |
| `SEARCH_PASSWORD` | 空 | 非空时启用密码门，搜索时需输入密码（5 次失败锁定 5 分钟） |
| `TURSO_URL` / `TURSO_AUTH_TOKEN` | 空 | 热搜存储（Turso libSQL，必配）。未配置时热搜功能不可用（接口报错，不降级） |

### 部署差异说明

| 特性 | Docker/Node | CF Workers / Vercel |
|------|-------------|---------------------|
| 进程内缓存 | ✅ 持久 | ❌ 每个 isolate 独立 |
| 热搜数据持久化 | ✅ Turso | ✅ Turso（需配 `TURSO_URL`，未配则热搜不可用） |
| 插件健康状态 | ✅ 持久 | ❌ 每次冷启动重置 |
| 链接有效性检测 | ✅ 持久缓存 | ✅（探活缓存按实例独立） |

---

## 🏗️ 技术架构

### 前端技术栈

- **框架**：Nuxt 4 + Vue 3
- **样式**：原生 CSS（无框架依赖）
- **状态管理**：Vue Composition API
- **类型安全**：TypeScript

### 后端技术栈

- **运行时**：Nitro（Nuxt 内置）
- **HTML 解析**：Cheerio（TG 频道 + 插件）
- **HTTP 客户端**：ofetch
- **并发控制**：p-limit
- **数据库**：Turso（libSQL，热搜持久化，HTTP 驱动跨部署通用）
- **测试框架**：Vitest

### 核心模块

```
server/core/
├── services/
│   ├── searchService.ts    # 搜索编排器（熔断器 + AbortController + 缓存）
│   ├── tg.ts               # TG 频道抓取
│   ├── doubanHotService.ts # 豆瓣榜单（JSON API + 24h 缓存）
│   ├── hotSearchService.ts # 热搜持久化
│   └── ...
├── cache/
│   └── memoryCache.ts      # LRU 缓存
├── plugins/                # 20+ 搜索插件
│   ├── manager.ts          # 插件注册
│   ├── pluginHealth.ts     # 熔断器
│   └── ...
└── utils/
    ├── fetch.ts            # 网络请求（重试 + 超时）
    ├── errors.ts           # 错误分类
    ├── searchKeyword.ts    # CJK 关键词变体
    └── logger.ts           # 日志

server/api/
└── check.post.ts           # 链接有效性检测（服务端探活）

composables/
└── useLinkCheck.ts         # 前端异步懒查（角标渲染）
```

---

## 📦 支持的网盘平台

| 平台 | 图标 | 说明 |
|------|------|------|
| 阿里云盘 | ☁️ | 支持分享链接解析 |
| 夸克网盘 | 🔎 | 支持分享链接解析 |
| 百度网盘 | 🧰 | 支持分享链接解析 |
| 115网盘 | 📦 | 支持分享链接解析 |
| 迅雷云盘 | ⚡ | 支持分享链接解析 |
| UC网盘 | 🧭 | 支持分享链接解析 |
| 天翼云盘 | ☁️ | 支持分享链接解析 |
| 123网盘 | # | 支持分享链接解析 |
| 移动云盘 | 📱 | 支持分享链接解析 |
| 磁力链接 | 🧲 | 支持 magnet 提取 |

---

## 🤝 贡献指南

欢迎提交 Issue 和 Pull Request！

### 开发规范

- 使用 TypeScript 编写
- 核心功能必须包含单元测试（TDD 优先）
- 提交前运行 `npm test`
- 遵循 [Conventional Commits](https://www.conventionalcommits.org/)

### 测试

```bash
# 运行所有测试（125+ 测试用例）
npm test

# 监听模式
npm test:watch

# 生成覆盖率报告
npm test:coverage
```

---

## 🍴 Fork 自动同步

仓库内置了 [`.github/workflows/sync-upstream.yml`](.github/workflows/sync-upstream.yml)，fork 之后每天 03:00 UTC 会自动拉取上游 `main` 合并回你的 fork（也可在 Actions 里手动触发）。

**默认行为**：自动同步全部代码；`.github/workflows/` 目录保持 fork 本地版本（不会覆盖你 fork 里的 workflow 文件）。这是 GitHub 的硬性规则——`GITHUB_TOKEN` 永远没有 `workflows` 权限，任何 `permissions:` 声明都无法授予，推送 workflow 文件会被整次拒绝。

**想连 workflow 文件一起同步**：在 fork 的 **Settings → Secrets and variables → Actions** 添加 `SYNC_TOKEN` secret：

- Fine-grained PAT：勾选 Contents **Read and write** + Workflows **Read and write**（Metadata 自动只读）
- 或 Classic PAT：勾选 `workflow` scope

配置后自动同步即升级为完整同步（含 `.github/workflows/`）。

**遇到报错怎么办**：如果看到

```
! [remote rejected] main -> main (refusing to allow a GitHub App to create or update
  workflow `.github/workflows/xxx.yml` without `workflows` permission)
```

这是旧版同步逻辑用 `GITHUB_TOKEN` 推送了 workflow 文件所致。升级到新版（自动跳过 workflow 文件）后不再出现；若 fork 卡在旧版，**手动同步一次**即可恢复：fork 页面 → **Sync fork** → **Update branch**，或 `gh repo sync <你的账号>/panhub.shenzjd.com`。

---

## 🛡️ 免责声明

- 本项目仅用于技术学习与搜索聚合演示
- 不存储、不传播任何受版权保护的内容
- 所有资源链接来自公开网络（Telegram 频道、第三方网站）
- 请遵守当地法律法规与平台使用条款
- 侵权问题请联系源站处理

---

## 📄 许可证

[MIT License](LICENSE)

---

## 🙏 鸣谢

- [Nuxt.js](https://nuxt.com/) - 渐进式 Vue 框架
- [Nitro](https://nitro.unjs.io/) - Web 服务器工具包
- [Cheerio](https://cheerio.js.org/) - HTML 解析器
- [p-limit](https://github.com/sindresorhus/p-limit) - 并发控制
- [node:sqlite](https://nodejs.org/api/sqlite.html) - Node 内置 SQLite
- [Vitest](https://vitest.dev/) - 测试框架

---

**⭐ 如果觉得有用，请给个 Star 支持一下！**

**在线体验**：<https://panhub.shenzjd.com>
