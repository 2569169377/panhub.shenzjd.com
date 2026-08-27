# Bot 防御与运维（2026-08-24）

## 背景

2026-08-24 用户报告：数据库出现大量「数字+文字+&+人名」模板型刷词，攻击者用真实 Chrome UA 绕过 UA 校验、用分布式低频（每 IP 不到 60 req/min）绕过限流中间件，词条含中文又过了 `isRejectedTerm`。

为应对这波 + 后续可能的同类攻击，引入四层防御：

| 层 | 文件 | 作用 |
|---|---|---|
| 1. UA 校验 | `server/utils/requireAuth.ts` | bot UA + 无凭证 → 403 |
| 2. IP 限流 | `server/middleware/rateLimiter.ts` | 60 req/IP/min → 429 |
| 3. 词条格式过滤 | `server/utils/recordSearchTerm.ts` | URL/控制字符/纯符号 → 不入库 |
| 4. **IP 黑名单** | `server/core/services/botDefense.ts` | **同一 IP 累计 ≥5 reject / 60s → 自动 24h 拉黑** |

## IP 黑名单机制

### 触发路径

任何一处拦截都会把 IP 推到 `BotDefenseService.recordRejection`：

- **bot_ua**：requireHumanOrCredential 拦截 / requireWxAuth 校验失败
- **rate_limit**：单 IP 触达 60 req/min（429）
- **bad_term**：URL/控制字符/纯符号（脚本探测）

每次记录：
1. 调 `store.recordRejection` 累计 `hit_count` 到 Turso `rejected_ips` 表
2. 滑动窗口（60s 内）≥5 次 → 自动 `store.extendBlock` 拉黑 24h
3. 立即写 pos 内存 cache（5min 复用），下次 `isBlocked` 直接命中放行

### 查询流程

`/api/search`（GET/POST）入口最前：

```
isBlocked(ip)?    ← posCache(5min) → negCache(30s) → Turso
  ↓ 是             命中 → 403 "ip blocked"（连 UA 校验都跳过）
  ↓ 否
requireHumanOrCredential (UA)
  ↓
requireWxAuth (公众号登录态)
  ↓
... 业务
```

### 部署运维

#### Worker（Cloudflare Workers）

环境变量已支持，从 `wrangler secret put` 配置即可。**首次部署会自动建表**（`rejected_ips`，`CREATE TABLE IF NOT EXISTS`）。

```
# 必须保留（防刷基础设施）
wrangler secret put TURSO_URL
wrangler secret put TURSO_AUTH_TOKEN
```

#### Docker

服务器 .env 写入：

```bash
TURSO_URL=libsql://xxx.turso.io
TURSO_AUTH_TOKEN=eyJ...
```

容器启动时同样会建表。

#### 查询当前黑名单

本地脚本（参考 `scripts/diag-bot-spam.mjs` 模式）：

```sql
SELECT ip, hit_count, reason, first_at, last_at, expires_at
FROM rejected_ips
WHERE expires_at > strftime('%s','now') * 1000
ORDER BY last_at DESC;
```

#### 手工解封某个 IP

```sql
DELETE FROM rejected_ips WHERE ip = '1.2.3.4';
```

24h 自动过期也可不管。

#### prune 策略

`BotDefenseService.startMaintenance()` 每 5min 调一次 `pruneExpired`，自动清理 `expires_at <= now` 的条目。

## 公众号登录强制认证（写死强制，无开关）

第三个加固方案：所有 `POST /api/search` / `GET /api/search` 都必须带 `wxauth-token` cookie，未带 → 401 "wx auth required"。

代码位置：`server/utils/wxAuthCheck.ts`（校验实现）+ `server/utils/requireAuth.ts`（`requireWxAuth` 入口拦截）。

**2026-08-26 起写死强制**：不再有 `WX_AUTH_ENFORCE` 环境变量，所有部署（主站 + fork 站）生产环境恒强制；本地 `npm run dev`（import.meta.dev）自动放行。前端 `useWxAuth.ts` 同步恒 `required`（弹窗不可关闭）——前端拦截 + 后端 401 双保险，无需任何部署配置。

### 副作用预警

- 未关注公众号的真人用户直接 401，体验影响大（这是产品设计，不是 bug）
- fork 站在自己域名完成一次关注+验证码后，cookie 写在自己域名（1 年有效），后续搜索静默放行、不再弹
- 小程序走独立登录通道（`/api/mp/login` → Bearer token），不依赖公众号认证；`requireWxAuth` 校验 Bearer 有效性，有效放行、无效 401（2026-08-28 新增，详见下方"小程序登录"章节）
- **wx-auth 服务故障 → fail-closed（拒绝）**：宁可误伤，不裸奔（2026-08-26 用户拍板，之前是降级放行）

## 小程序登录（2026-08-28 新增）

### 背景

公众号 openid 与小程序 openid 不是同一个（个人订阅号未认证，拿不到 unionid），无法打通。小程序走独立的 `wx.login → code2session` 登录流程，后端用小程序自己的 appid+secret 换 openid，签发 Bearer token。

### 流程

```
小程序 wx.login() → code
  ↓ POST /api/mp/login { code }
后端用 MP_APPID + MP_SECRET 调微信 code2session → openid
  ↓ 签发 token（存 Turso mp_token 表，7 天有效）
返回 { token, openid }
  ↓
小程序后续请求带 Authorization: Bearer <token>
  ↓ requireWxAuth 校验 token 有效性
有效 → 放行；无效 → 401
```

### 环境变量

```bash
# 小程序凭证（微信公众平台 → 开发 → 开发设置）
MP_APPID=wx_your_appid
MP_SECRET=your_app_secret

# Turso（复用现有基础设施，mp_token 表自动建表）
TURSO_URL=libsql://xxx.turso.io
TURSO_AUTH_TOKEN=eyJ...
```

### 安全设计

- **身份验证靠小程序 appid + secret**：只有你的小程序能换出有效 openid（别人的小程序用他们的 appid，换不到你后端认可的 openid）
- **token 可吊销、即时生效**：泄露时后端 `revokeToken` / `revokeByOpenid` 即时生效，**无需小程序发版**
- **fail-closed**：code2session 远程故障 / Turso 不可用 → 拒绝，不降级放行
- 与公众号认证**物理隔离**：小程序 openid 存本项目 `mp_token` 表，公众号 openid 存 wx-auth 项目，两套独立不混淆

### 管理操作

```sql
-- 查看当前有效 token
SELECT token, openid, created_at, expires_at FROM mp_token WHERE revoked = 0 AND expires_at > strftime('%s','now') * 1000;

-- 吊销某 openid 所有 token（泄露时一键生效）
UPDATE mp_token SET revoked = 1 WHERE openid = 'xxx' AND revoked = 0;

-- 清理过期 token
DELETE FROM mp_token WHERE expires_at <= strftime('%s','now') * 1000;
```

### 测试

```bash
npx vitest run test/unit/mpToken.test.ts
```

### ⚠️ 上线前必做：本地验证手册

本地 dev（import.meta.dev）自动放行强制校验，要完整验证鉴权链路需让 dev server 走校验分支——用本地 mock wx-auth 服务配合：

#### 步骤 1：启动本地 mock wx-auth 服务

```bash
node scripts/mock-wx-auth.mjs &
# [mock-wx-auth] listening on http://localhost:8899
# [mock-wx-auth] 白名单 token: test-fake-token  openid: test-fake-openid
```

默认会接受 `Cookie: wxauth-token=test-fake-token` 当作"已登录真人"。要扩展白名单，创建 `scripts/.wx-auth-mock.json`：

```json
{
  "tokens": ["test-fake-token", "browser-copied-real-token"],
  "openids": ["test-fake-openid"]
}
```

#### 步骤 2：启动 dev server（指向 mock）

```bash
WX_AUTH_API_BASE=http://localhost:8899 npm run dev
```

#### 步骤 3：本地 curl 验证四种场景

```bash
# A. 已登录 token → 应 200 + 搜索结果
curl -i -H "Cookie: wxauth-token=test-fake-token" \
  'http://localhost:4000/api/search?kw=凡人修仙传'

# B. 无 cookie → 应 401 wx auth required
curl -i 'http://localhost:4000/api/search?kw=凡人修仙传'

# C. 错误 token → 应 401 + 累积 IP bad_term
curl -i -H "Cookie: wxauth-token=garbage" \
  'http://localhost:4000/api/search?kw=凡人修仙传'

# D. Bearer 凭证（小程序）→ 需有效 token 才 200（2026-08-28 起校验）
#    先调 /api/mp/login 签发 token（需配 MP_APPID/MP_SECRET），
#    再用返回的 token 调搜索：
curl -i -H 'Authorization: Bearer <有效token>' \
  'http://localhost:4000/api/search?kw=凡人修仙传'
#    无效 token → 401（不再像以前随便填就放行）
```

**预期**：A=D=200 且有搜索结果，B=C=401。如果 A 失败 → 调 mock 白名单 + 确认 `WX_AUTH_API_BASE` 指向 mock，调查通过路径。

#### 步骤 4：试产前再用真实 cookie 测一次

复制浏览器真实登录态的 `wxauth-token`，修改 `scripts/.wx-auth-mock.json` 加上这个 token，重启 mock 服务，然后 curl 复测。验证走真实 `https://wx-auth.shenzjd.com` 时也没问题（默认 `WX_AUTH_API_BASE` 不设也能跑）。

### 部署

写死强制后无需任何额外配置：

- **Worker**：旧 `wrangler secret put WX_AUTH_ENFORCE=1` 已无作用，可直接忽略/删除（代码不再读该变量）
- **Docker**：服务器 .env 里的 `WX_AUTH_ENFORCE=1` 同样无作用，无感
- 新代码部署后即全部强制生效

### 性能开销

每次搜索多 1 次 `https://wx-auth.shenzjd.com/api/auth/check` 调用（5s timeout），但同一 token 10min 内第二次起走内存缓存（`verifyWxAuthOnceCached`），不再打远程；wx-auth 服务故障 → fail-closed 拒绝（2026-08-26 用户拍板）。

## 测试

```bash
npx vitest run test/unit/botDefense.test.ts
```

10 用例覆盖 isBlocked 缓存、recordRejection 阈值、滑动窗口、Turso 不可用降级。
