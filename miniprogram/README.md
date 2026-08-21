# PanHub 小程序

原生微信小程序（无 uni-app / Taro / TDesign），纯原生组件实现，微信官方绿色调（#07C160）。

## 目录结构

```
miniprogram/
├── app.js / app.json / app.wxss    入口（3 tab：搜索 / 热搜 / 设置）
├── custom-tab-bar/                 自定义 TabBar（icon + label 竖排，选中微信绿）
├── project.config.json             微信开发者工具配置
├── sitemap.json
├── pages/
│   ├── index/                      搜索首页（沉浸绿渐变 Hero + 搜索 + 热门词条 + 结果分组）
│   ├── hot/                        热搜趋势（搜索日历 + 今日 TOP + 飙升榜）
│   └── settings/                   设置（密码锁 / 深色模式 / 默认平台 / 排序 / 历史 / 关于 / 反馈）
└── utils/
    ├── api.js                      wx.request 封装（自动带 token / client-secret）
    ├── auth.js                     密码锁鉴权（/api/auth/status|unlock）
    ├── extract.js / merge.js       结果归一化（与 Web 端 shared_* 同语义）
```

## 页面

| 页面 | 说明 |
|---|---|
| 搜索（tab 0） | 自定义导航沉浸式微信绿渐变 Hero；搜索条；热门搜索词条（点击即搜）；热搜趋势入口；覆盖平台；搜索后展示统计 + 平台筛选 + 分组结果卡（复制链接）；密码锁浮层 |
| 热搜趋势（tab 1） | 近 7 天搜索日历（今天绿色高亮）；今日 TOP（前 3 红榜）；飙升榜（今日 vs 昨日涨幅，TOP1 高亮）；点击词条跳回首页自动搜索 |
| 设置（tab 2） | 品牌卡 + 7 项设置（搜索密码锁开关 / 深色模式 / 默认搜索平台 / 结果排序 / 清除搜索历史 / 关于 / 反馈） |

## 设计系统（微信官方色调）

- 主色 `#07C160` / 深绿 `#06AD56` / 浅绿 `#E8F8EF` / 页面灰 `#F7F7F7` / 官方红 `#FA5151`
- 平台色：夸克 `#1A94FF` / 阿里云盘 `#FF6B38` / 百度网盘 `#2A5BF2` / 115 `#ED3D3D` / 迅雷 `#0D87E0`（`shared_platforms.js`）
- 设计稿：`docs/miniprogram-design/`（Ardot 画布 fileId `717233100727953`）

## 本地开发

1. 微信开发者工具导入本目录（appid `wx3777783c3d796775`）
2. 无需 npm install / 构建 npm（零第三方依赖）
3. 后端接口默认 `https://panhub.shenzjd.com`（`app.js` 可改）

## 待办

- [ ] 深色模式落地（当前仅存储偏好）
- [ ] 搜索结果页"查看全部"展开优化
