# PanHub 小程序

原生微信小程序（无 uni-app / Taro），使用 TDesign MP 组件库。

## 目录结构

```
miniprogram/
├── app.js / app.json / app.wxss    入口
├── project.config.json             微信开发者工具配置
├── sitemap.json
├── pages/
│   ├── index/                      搜索首页
│   └── settings/                   设置
└── utils/
    ├── api.js                      wx.request 封装（自动带 MP_CLIENT_SECRET）
    ├── merge.js                    require ../../../shared/merge.js
    └── extract.js                  require ../../../shared/extract.js
```

## 初始化步骤

1. 在 `mp.weixin.qq.com` 申请小程序账号（没有则点"小程序类目"用测试号）
2. **开发设置 → 服务器域名** 加白名单：
   - request 合法域名：`https://panhub.shenzjd.com`
   - downloadFile 合法域名：`https://panhub.shenzjd.com`
3. 云函数/可选：无
4. 进入 `miniprogram/`，安装依赖：
   ```bash
   cd miniprogram
   npm install
   ```
5. 打开 **微信开发者工具** → 导入项目 → 选 `miniprogram/` 根目录（非外层）→ AppID 用测试号或真实 AppID
6. 微信开发者工具里 **工具 → 构建 npm**（生成 `miniprogram/miniprogram_npm/`）
7. 编译、看效果

## TDesign 主题覆盖

见 `app.wxss` 中的 `--td-*` CSS 变量。想换主题色时在这里改。

## 搜索接口说明

MP 端采用**前端扇出**（与 Web 端同源语义）—— `api.search(keyword, { src, plugins, channels, … })` 拼 query string 调 `/api/search`。

后端改造点（已在 `server/utils/auth.ts` 里完成）：
- 响应 `/api/auth/unlock` 返回 `{ ok, token }`（HMAC token，不返回明文密码）
- `isUnlocked` 同时兼容：Web Cookie / MP Bearer / MP `x-panhub-client-secret` 共享密钥（初期免密）

## 小程序鉴权（解锁流程）

后端 `/api/auth/unlock` 在密码门开启时返回 `{ ok, token }`，该 `token` 即 Bearer 凭证。
小程序逻辑（`utils/auth.js` + `pages/index`）：

1. 启动即调 `/api/auth/status`，若 `locked:true` 则弹出解锁浮层。
2. 用户输入密码 → `POST /api/auth/unlock` → 成功后将 `token` 存 `wx.setStorageSync('panhub_token')`。
3. 之后每次请求 `utils/api.js` 自动带上 `Authorization: Bearer <token>`。
4. 若后端返回 401（凭证失效），自动重新弹出解锁浮层。
5. 设置页可「退出解锁」清除本地 token。

> 若后端未设 `SEARCH_PASSWORD`（无密码门），`/api/auth/status` 返回 `locked:false`，小程序无需解锁直接可用。

## 后续待办

- [ ] settings 页 → 插件开关 / TG 频道开关
- [ ] 搜索历史（wx.setStorageSync 本地即可）
- [ ] 热搜详情页
- [ ] 深色模式（TDesign 自带主题）
