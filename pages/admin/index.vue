<script setup lang="ts">
/**
 * PanHub 管理面板（2026-08-25 重构）
 * 布局：左侧固定菜单 + 右侧内容区（不再是顶部 Tab）
 *
 * 菜单：
 * - 搜索记录：谁搜了什么 / 某词谁搜过；每行 IP 可一键「拉黑」
 * - IP 黑名单：封禁中 / 惯犯档案；每行可「移除」（解除封禁）
 *
 * 鉴权（2026-08-25 用户拍板：打开管理页就查一次 user info 看权限）：
 * - 子站在根域 .shenzjd.com 静默登录过 → wxauth-token cookie 共享
 * - onMounted 主动调 /api/blacklist 探测：200→管理员显示内容；
 *   401→未登录（提示去首页）；403→非管理员
 */

definePageMeta({
  title: "PanHub 管理",
  // 2026-08-25：管理页走纯净后台布局（layouts/admin.vue），
  // 与正常客户页面（layouts/default.vue）完全解耦，互不影响
  layout: "admin",
});

useSeoMeta({
  title: "PanHub 管理",
  robots: "noindex,nofollow", // 管理页禁止收录
});

/** 菜单项（新增功能往这里加即可） */
const MENUS = [
  { key: "search-log", label: "搜索记录", icon: "🔍" },
  { key: "blacklist", label: "IP 黑名单", icon: "🚫" },
] as const;
type MenuKey = (typeof MENUS)[number]["key"];

const activeKey = ref<MenuKey>("search-log");

/** 权限状态：checking=检测中 / ok=管理员 / no-login=未登录 / no-admin=非管理员 */
const authStatus = ref<"checking" | "ok" | "no-login" | "no-admin">("checking");

/* ---------- 搜索记录 ---------- */
const mode = ref<"openid" | "term">("openid");
const keyword = ref("");
const days = ref("7");
const loading = ref(false);
const error = ref("");
const items = ref<any[]>([]);
const total = ref(0);
const lastQuery = ref("");

const modeLabel = computed(() => (mode.value === "openid" ? "openid" : "搜索词"));

function formatTime(ms: number): string {
  if (!ms) return "-";
  const d = new Date(ms + 8 * 3600 * 1000); // 北京时间
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

async function doSearchLog() {
  const kw = keyword.value.trim();
  if (!kw) return;
  loading.value = true;
  error.value = "";
  try {
    const d = days.value ? `&days=${encodeURIComponent(days.value)}` : "";
    const key = mode.value === "openid" ? "openid" : "term";
    const res = await fetch(`/api/search-log?${key}=${encodeURIComponent(kw)}&limit=100${d}`);
    if (res.status === 403) { authStatus.value = "no-admin"; items.value = []; total.value = 0; return; }
    if (res.status === 401) { authStatus.value = "no-login"; items.value = []; total.value = 0; return; }
    if (!res.ok) { error.value = `请求失败（HTTP ${res.status}）`; items.value = []; total.value = 0; return; }
    const data = await res.json();
    items.value = data.data?.items ?? [];
    total.value = data.data?.total ?? 0;
    lastQuery.value = kw;
  } catch (e: any) {
    error.value = e?.message || "请求异常";
  } finally {
    loading.value = false;
  }
}

/* ---------- IP 黑名单 ---------- */
const blLoading = ref(false);
const blError = ref("");
const blItems = ref<any[]>([]);
const blTotal = ref(0);
/** 正在操作的 key（按钮 loading 态），形如 `block-1.2.3.4` / `remove-1.2.3.4` */
const busyKey = ref("");

const reasonText: Record<string, string> = {
  bot_ua: "爬虫UA",
  rate_limit: "限流",
  bad_term: "非法词",
  wx_auth: "未关注公众号",
  manual: "手动拉黑",
};

function blockLevelText(blockCount: number): string {
  if (!blockCount) return "未拉黑";
  if (blockCount === 1) return "24 小时";
  if (blockCount === 2) return "7 天";
  return "30 天";
}

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return "-";
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时`;
  return `${Math.floor(h / 24)} 天`;
}

async function loadBlacklist() {
  blLoading.value = true;
  blError.value = "";
  try {
    const res = await fetch("/api/blacklist?limit=200");
    if (res.status === 403) { authStatus.value = "no-admin"; blItems.value = []; blTotal.value = 0; return; }
    if (res.status === 401) { authStatus.value = "no-login"; blItems.value = []; blTotal.value = 0; return; }
    if (!res.ok) { blError.value = `请求失败（HTTP ${res.status}）`; blItems.value = []; blTotal.value = 0; return; }
    const data = await res.json();
    blItems.value = data.data?.items ?? [];
    blTotal.value = data.data?.total ?? 0;
    authStatus.value = "ok";
  } catch (e: any) {
    blError.value = e?.message || "请求异常";
  } finally {
    blLoading.value = false;
  }
}

/**
 * 从搜索记录把某个 IP 直接拉黑（2026-08-25 新增）
 * 确认弹窗 → POST /api/blacklist → 刷新黑名单 → 从当前结果里剔除已拉黑行
 */
async function blockSearchIp(ip: string) {
  if (!ip || busyKey.value) return;
  if (!window.confirm(`确定将 IP ${ip} 加入黑名单？\n立即封禁 30 天，该 IP 的搜索请求将被拦截。`)) return;
  busyKey.value = `block-${ip}`;
  try {
    const res = await fetch("/api/blacklist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ip, reason: "manual" }),
    });
    if (res.status === 401) { authStatus.value = "no-login"; return; }
    if (res.status === 403) { authStatus.value = "no-admin"; return; }
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      alert(d?.message || `拉黑失败（HTTP ${res.status}）`);
      return;
    }
    // 搜索记录里剔除该 IP 的行，避免重复操作
    items.value = items.value.filter((it) => it.ip !== ip);
    // 若当前黑名单 tab 已加载过，同步刷新
    if (blItems.value.length > 0) {
      await loadBlacklist();
    }
  } catch (e: any) {
    alert(e?.message || "请求异常");
  } finally {
    busyKey.value = "";
  }
}

/** 移除黑名单 IP（解除封禁，2026-08-25 新增） */
async function removeBlIp(ip: string) {
  if (busyKey.value) return;
  if (!window.confirm(`确定将 IP ${ip} 移出黑名单？\n将立即解除封禁（删除该 IP 的全部记录）。`)) return;
  busyKey.value = `remove-${ip}`;
  try {
    const res = await fetch(`/api/blacklist?ip=${encodeURIComponent(ip)}`, { method: "DELETE" });
    if (res.status === 401) { authStatus.value = "no-login"; return; }
    if (res.status === 403) { authStatus.value = "no-admin"; return; }
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      alert(d?.message?.message || `移除失败（HTTP ${res.status}）`);
      return;
    }
    blItems.value = blItems.value.filter((it) => it.ip !== ip);
    blTotal.value = blTotal.value - 1;
  } catch (e: any) {
    alert(e?.message || "请求异常");
  } finally {
    busyKey.value = "";
  }
}

// 打开管理页即探测管理员权限（2026-08-25 用户拍板：只查一次 user info）：
// - 子站都在根域 .shenzjd.com 静默登录过，token cookie 共享，后端直接读 cookie
//   → userinfo → isAdmin 判定，无需前端再触发 silentCheck
// - 但"直接打开 /admin"（新标签/新会话）可能无 token → 兜底调一次 silentCheck 写 token
onMounted(() => {
  if (
    typeof document !== "undefined" &&
    !/(?:^|; )wxauth-token=/.test(document.cookie)
  ) {
    // 动态 import SDK 避免 SSR 报错（document/window 不可用）
    import("wx-auth-sdk").then(({ WxAuth }) => {
      WxAuth.silentCheck().finally(() => loadBlacklist());
    });
  } else {
    loadBlacklist();
  }
});

// 切到黑名单：数据为空时才拉（避免无谓请求）
watch(activeKey, (k) => {
  if (k === "blacklist" && blItems.value.length === 0 && !blError.value) {
    loadBlacklist();
  }
});
</script>

<template>
  <div class="admin-layout">
    <!-- 左侧菜单 -->
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-title">PanHub</div>
        <div class="brand-sub">管理后台</div>
      </div>
      <nav class="menu">
        <button
          v-for="m in MENUS"
          :key="m.key"
          type="button"
          :class="['menu-item', { active: activeKey === m.key }]"
          @click="activeKey = m.key">
          <span class="menu-icon">{{ m.icon }}</span>
          <span>{{ m.label }}</span>
        </button>
      </nav>
      <div class="sidebar-foot">v1 · 2026-08-25</div>
    </aside>

    <!-- 右侧内容区 -->
    <main class="content">
      <!-- 权限状态（2026-08-25：打开页面即请求 user info 看权限） -->
      <div v-if="authStatus === 'checking'" class="notice">正在检测登录状态…</div>
      <div v-else-if="authStatus === 'no-login'" class="notice error">
        <strong>请先登录</strong>：管理页需要微信关注公众号登录态。
        <NuxtLink to="/" class="notice-link">去首页完成关注验证 →</NuxtLink>
      </div>
      <div v-else-if="authStatus === 'no-admin'" class="notice error">
        <strong>无权限访问</strong>：当前账号不是管理员。请在 wx-auth 后台将该账号标记为管理员后重试。
      </div>

      <template v-else>
        <!-- ===== 菜单：搜索记录 ===== -->
        <section v-if="activeKey === 'search-log'" class="panel">
          <div class="panel-head">
            <h2>搜索记录</h2>
            <p class="panel-desc">谁搜了什么 / 某词谁搜过。可对异常 IP 一键加入黑名单。</p>
          </div>

          <div v-if="error" class="notice error">{{ error }}</div>
          <form class="query-form" @submit.prevent="doSearchLog">
            <div class="mode-tabs">
              <button type="button" :class="['mode-tab', { active: mode === 'openid' }]" @click="mode = 'openid'">按 openid 查</button>
              <button type="button" :class="['mode-tab', { active: mode === 'term' }]" @click="mode = 'term'">按搜索词查</button>
            </div>
            <div class="form-row">
              <input
                v-model="keyword"
                type="text"
                :placeholder="mode === 'openid' ? '输入 openid' : '输入搜索词'"
                class="query-input" />
              <select v-model="days" class="days-select" aria-label="时间范围">
                <option value="1">近 1 天</option>
                <option value="7">近 7 天</option>
                <option value="30">近 30 天</option>
                <option value="90">近 90 天</option>
              </select>
              <button type="submit" class="query-btn" :disabled="loading || !keyword.trim()">
                {{ loading ? "查询中…" : "查询" }}
              </button>
            </div>
          </form>

          <div v-if="items.length > 0" class="result-head">
            <span>共 {{ total }} 条记录（{{ modeLabel }}：{{ lastQuery }}）</span>
          </div>
          <div v-if="loading" class="notice">查询中…</div>
          <div v-else-if="authStatus !== 'no-login' && authStatus !== 'no-admin' && !error && lastQuery && items.length === 0" class="notice">
            无记录（该时间范围内没有数据）
          </div>

          <div v-if="items.length > 0" class="table-wrap">
            <table class="result-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>搜索词</th>
                  <th v-if="mode === 'term'">openid</th>
                  <th>IP</th>
                  <th>时间（北京时间）</th>
                  <th class="th-op">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(it, idx) in items" :key="idx">
                  <td>{{ idx + 1 }}</td>
                  <td>{{ it.term ?? "-" }}</td>
                  <td v-if="mode === 'term'" class="mono">{{ it.openid ?? "-" }}</td>
                  <td class="mono">{{ it.ip || "-" }}</td>
                  <td class="mono">{{ formatTime(it.createdAt) }}</td>
                  <td class="op-cell">
                    <button
                      v-if="it.ip"
                      type="button"
                      class="btn btn-danger btn-sm"
                      :disabled="busyKey !== ''"
                      @click="blockSearchIp(it.ip)">
                      {{ busyKey === `block-${it.ip}` ? "拉黑中…" : "拉黑" }}
                    </button>
                    <span v-else class="no-op">-</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <!-- ===== 菜单：IP 黑名单 ===== -->
        <section v-if="activeKey === 'blacklist'" class="panel">
          <div class="panel-head">
            <h2>IP 黑名单</h2>
            <p class="panel-desc">封禁中+惯犯档案+计数记录 · 顽固爬虫分级递增（24h → 7 天 → 30 天）</p>
          </div>

          <div v-if="blError" class="notice error">{{ blError }}</div>
          <div class="result-head">
            <span>共 {{ blTotal }} 条记录</span>
            <button type="button" class="refresh-btn" :disabled="blLoading" @click="loadBlacklist">
              {{ blLoading ? "刷新中…" : "刷新" }}
            </button>
          </div>
          <div v-if="blLoading" class="notice">加载中…</div>

          <div v-if="blItems.length > 0" class="table-wrap">
            <table class="result-table">
              <thead>
                <tr>
                  <th>IP</th>
                  <th>原因</th>
                  <th>状态</th>
                  <th>封禁档位</th>
                  <th>剩余</th>
                  <th>解封时间（北京）</th>
                  <th>累计拒绝</th>
                  <th>最近活动（北京）</th>
                  <th class="th-op">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="it in blItems" :key="it.ip">
                  <td class="mono">{{ it.ip }}</td>
                  <td>{{ reasonText[it.reason] ?? it.reason }}</td>
                  <td>
                    <span :class="['badge', it.blocked ? 'badge-blocked' : 'badge-free']">
                      {{ it.blocked ? "封禁中" : "已解封" }}
                    </span>
                  </td>
                  <td>{{ blockLevelText(it.blockCount) }}</td>
                  <td>{{ it.blocked ? formatDuration(it.remainingMs) : "-" }}</td>
                  <td class="mono">{{ formatTime(it.expiresAt) }}</td>
                  <td>{{ it.hitCount }}</td>
                  <td class="mono">{{ formatTime(it.lastAt) }}</td>
                  <td class="op-cell">
                    <button
                      type="button"
                      class="btn btn-neutral btn-sm"
                      :disabled="busyKey !== ''"
                      @click="removeBlIp(it.ip)">
                      {{ busyKey === `remove-${it.ip}` ? "移除中…" : "移除" }}
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-else-if="!blLoading && !blError" class="notice">暂无黑名单记录</div>
        </section>
      </template>
    </main>
  </div>
</template>

<style scoped>
.admin-layout {
  display: flex;
  min-height: 100vh;
  color: var(--text-color, #1f2937);
  background: var(--bg-subtle, #f8fafc);
  font-size: 14px;
}

/* ---------- 左侧菜单 ---------- */
.sidebar {
  width: 208px;
  flex-shrink: 0;
  background: var(--card-bg, #fff);
  border-right: 1px solid var(--border-color, #e5e7eb);
  display: flex;
  flex-direction: column;
  padding: 20px 12px;
  position: sticky;
  top: 0;
  height: 100vh;
  box-sizing: border-box;
}
.brand { padding: 0 10px 18px; border-bottom: 1px solid var(--border-color, #eee); margin-bottom: 14px; }
.brand-title { font-size: 20px; font-weight: 700; letter-spacing: 0.5px; }
.brand-sub { font-size: 12px; color: var(--muted-color, #6b7280); margin-top: 2px; }
.menu { display: flex; flex-direction: column; gap: 4px; flex: 1; }
.menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary, #4b5563);
  font-size: 14px;
  cursor: pointer;
  text-align: left;
  transition: background 0.15s, color 0.15s;
}
.menu-item:hover { background: var(--bg-subtle, #f1f5f9); }
.menu-item.active { background: var(--accent-bg, #2563eb); color: #fff; font-weight: 600; }
.menu-icon { width: 20px; text-align: center; }
.sidebar-foot { font-size: 11px; color: var(--muted-color, #9ca3af); padding: 12px 10px 0; border-top: 1px solid var(--border-color, #eee); }

/* ---------- 右侧内容 ---------- */
.content { flex: 1; min-width: 0; padding: 28px 32px 64px; }
.panel { max-width: 1080px; }
.panel-head { margin-bottom: 18px; }
.panel-head h2 { font-size: 20px; margin: 0 0 6px; }
.panel-desc { color: var(--muted-color, #6b7280); font-size: 13px; margin: 0; }

/* 通用提示 */
.notice { padding: 10px 14px; border-radius: 8px; background: var(--bg-subtle, #f3f4f6); margin: 10px 0; font-size: 14px; }
.notice.error { background: var(--danger-bg, #fef2f2); color: var(--danger-color, #dc2626); border: 1px solid var(--danger-border, #fecaca); }
.notice-link { margin-left: 6px; color: var(--accent, #2563eb); font-weight: 600; text-decoration: none; }
.notice-link:hover { text-decoration: underline; }

/* 查询区 */
.mode-tabs { display: flex; gap: 8px; margin-bottom: 12px; }
.mode-tab { padding: 6px 14px; border-radius: 999px; border: 1px solid var(--border-color, #e5e7eb); background: transparent; color: var(--text-secondary, #4b5563); cursor: pointer; font-size: 13px; }
.mode-tab.active { background: var(--accent-bg, #2563eb); color: #fff; border-color: transparent; }
.form-row { display: flex; gap: 8px; }
.query-input { flex: 1; padding: 9px 12px; border: 1px solid var(--border-color, #e5e7eb); border-radius: 8px; font-size: 14px; background: var(--input-bg, #fff); color: var(--text-color, #1f2937); min-width: 0; }
.days-select { padding: 9px 8px; border: 1px solid var(--border-color, #e5e7eb); border-radius: 8px; font-size: 13px; background: var(--input-bg, #fff); color: var(--text-color, #1f2937); }
.query-btn { padding: 9px 18px; border: none; border-radius: 8px; background: var(--accent-bg, #2563eb); color: #fff; font-size: 14px; cursor: pointer; white-space: nowrap; }
.query-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* 结果区 */
.result-head { display: flex; align-items: center; justify-content: space-between; margin: 16px 0 8px; font-size: 13px; color: var(--muted-color, #6b7280); }
.refresh-btn { padding: 5px 12px; border: 1px solid var(--border-color, #e5e7eb); border-radius: 6px; background: transparent; color: var(--text-secondary, #4b5563); font-size: 12px; cursor: pointer; }
.table-wrap { overflow-x: auto; margin-top: 8px; background: var(--card-bg, #fff); border: 1px solid var(--border-color, #e5e7eb); border-radius: 10px; }
.result-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.result-table th, .result-table td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--border-color, #eee); white-space: nowrap; }
.result-table tr:last-child td { border-bottom: none; }
.result-table th { color: var(--muted-color, #6b7280); font-weight: 500; border-bottom: 1px solid var(--border-color, #e5e7eb); }
.th-op { text-align: center; }
.op-cell { text-align: center; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }

/* 徽章 / 按钮 */
.badge { padding: 2px 8px; border-radius: 999px; font-size: 12px; }
.badge-blocked { background: var(--danger-bg, #fef2f2); color: var(--danger-color, #dc2626); }
.badge-free { background: var(--bg-subtle, #f3f4f6); color: var(--muted-color, #6b7280); }
.btn { padding: 4px 12px; border: none; border-radius: 6px; font-size: 12px; cursor: pointer; }
.btn-sm { padding: 4px 10px; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-danger { background: var(--danger-bg, #fee2e2); color: var(--danger-color, #dc2626); border: 1px solid var(--danger-border, #fecaca); }
.btn-danger:hover:not(:disabled) { background: var(--danger-color, #dc2626); color: #fff; }

/* 窄屏适配：侧栏变顶栏 */
@media (max-width: 768px) {
  .admin-layout { flex-direction: column; }
  .sidebar { width: 100%; height: auto; position: static; flex-direction: row; align-items: center; padding: 10px 12px; border-right: none; border-bottom: 1px solid var(--border-color, #e5e7eb); }
  .brand { padding: 0 12px 0 0; border-bottom: none; margin-bottom: 0; }
  .menu { flex-direction: row; gap: 4px; }
  .menu-item { padding: 6px 10px; }
  .sidebar-foot { display: none; }
  .content { padding: 20px 16px 48px; }
}
</style>