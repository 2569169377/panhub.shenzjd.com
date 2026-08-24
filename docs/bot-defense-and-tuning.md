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
requireSearchAuth (密码门)
  ↓
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

## 启用 WX_AUTH_ENFORCE（强制公众号登录）

第三个加固方案：所有 `POST /api/search` / `GET /api/search` 都必须带 `wxauth-token` cookie，未带 → 401 "wx auth required"。

代码层是现成的（`server/utils/wxAuthCheck.ts:31`），但**默认关闭**（WX_AUTH_ENFORCE != "1" 不生效），需要手动开启环境变量。

### 副作用预警

- 未关注公众号的真人用户直接 401，体验影响大
- API Key 持有者（小程序 / 已授权 client）不受影响（requireAuth 有 Bearer/client-secret 放行）
- 测试环境先开，确认无误再上生产

### ⚠️ 上线前必做：本地验证手册

上次打开 `WX_AUTH_ENFORCE=1` 时出过问题（用户描述），这次必须**先本地端到端验证**再上：

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

#### 步骤 2：启动 dev server（开启开关 + 指向 mock）

```bash
WX_AUTH_ENFORCE=1 WX_AUTH_API_BASE=http://localhost:8899 npm run dev
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

# D. Bearer 凭证（小程序）→ 应 200（已授权 client 不受 wxauth 影响）
curl -i -H 'Authorization: Bearer dev-bearer' \
  'http://localhost:4000/api/search?kw=凡人修仙传'
```

**预期**：A=D=200 且有搜索结果，B=C=401。如果 A 失败 → 立刻关停本地 mock + 回到 WX_AUTH_ENFORCE=0 状态，调查通过路径。

#### 步骤 4：试产前再用真实 cookie 测一次

复制浏览器真实登录态的 `wxauth-token`，修改 `scripts/.wx-auth-mock.json` 加上这个 token，重启 mock 服务，然后 curl 复测。验证走真实 `https://wx-auth.shenzjd.com` 时也没问题（默认 `WX_AUTH_API_BASE` 不设也能跑）。

### Worker 启用

确认 A/D 路径都好之后：

```bash
wrangler secret put WX_AUTH_ENFORCE
# 输入值: 1
```

### Docker 启用

服务器 .env 加：

```bash
WX_AUTH_ENFORCE=1
```

重启容器生效（docker compose restart panhub）。

### 性能开销

每次搜索多 1 次 `https://wx-auth.shenzjd.com/api/auth/check` 调用（5s timeout），fail-open 不误伤真人。生产压力评估后再开启。

## 测试

```bash
npx vitest run test/unit/botDefense.test.ts
```

10 用例覆盖 isBlocked 缓存、recordRejection 阈值、滑动窗口、Turso 不可用降级。
