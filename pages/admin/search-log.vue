<script setup lang="ts">
/**
 * 搜索记录排查管理页（2026-08-25）
 * - 鉴权：后端 /api/search-log 用 wx-auth isAdmin 判定，本页仅展示结果/403
 * - 两种查询：按 openid（谁搜了什么）/ 按词（谁搜过这词）
 * - 时间范围 days（默认 7 天）
 */

definePageMeta({
  title: "搜索记录排查 - PanHub 管理",
});

useSeoMeta({
  title: "搜索记录排查 - PanHub 管理",
  robots: "noindex,nofollow", // 管理页禁止收录
});

const mode = ref<"openid" | "term">("openid");
const keyword = ref("");
const days = ref("7");
const loading = ref(false);
const forbidden = ref(false);
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

async function doSearch() {
  const kw = keyword.value.trim();
  if (!kw) return;
  loading.value = true;
  error.value = "";
  forbidden.value = false;
  try {
    const d = days.value ? `&days=${encodeURIComponent(days.value)}` : "";
    const key = mode.value === "openid" ? "openid" : "term";
    const res = await fetch(`/api/search-log?${key}=${encodeURIComponent(kw)}&limit=100${d}`);
    if (res.status === 403) {
      forbidden.value = true;
      items.value = [];
      total.value = 0;
      return;
    }
    if (res.status === 401) {
      error.value = "未登录，请先在首页完成微信关注公众号验证";
      items.value = [];
      total.value = 0;
      return;
    }
    if (!res.ok) {
      error.value = `请求失败（HTTP ${res.status}）`;
      items.value = [];
      total.value = 0;
      return;
    }
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
</script>

<template>
  <div class="admin-page">
    <div class="admin-card">
      <h1>搜索记录排查</h1>
      <p class="desc">仅管理员可见。用于排查"哪个 openid 搜了什么 / 某词谁搜过"。</p>

      <!-- 403 提示 -->
      <div v-if="forbidden" class="notice error">
        <strong>无权限访问</strong>：当前账号不是管理员。请在 wx-auth 后台将该账号标记为管理员后重试。
      </div>
      <div v-else-if="error" class="notice error">{{ error }}</div>

      <form class="query-form" @submit.prevent="doSearch">
        <div class="mode-tabs">
          <button type="button" :class="['mode-tab', { active: mode === 'openid' }]" @click="mode = 'openid'">
            按 openid 查
          </button>
          <button type="button" :class="['mode-tab', { active: mode === 'term' }]" @click="mode = 'term'">
            按搜索词查
          </button>
        </div>

        <div class="form-row">
          <input
            v-model="keyword"
            type="text"
            :placeholder="mode === 'openid' ? '输入 openid' : '输入搜索词'"
            class="query-input"
          />
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

      <!-- 结果 -->
      <div v-if="items.length > 0" class="result-head">
        <span>共 {{ total }} 条记录（{{ modeLabel }}：{{ lastQuery }}）</span>
      </div>

      <div v-if="loading" class="notice">查询中…</div>
      <div v-else-if="!forbidden && !error && lastQuery && items.length === 0" class="notice">
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
            </tr>
          </thead>
          <tbody>
            <tr v-for="(it, idx) in items" :key="idx">
              <td>{{ idx + 1 }}</td>
              <td>{{ it.term ?? "-" }}</td>
              <td v-if="mode === 'term'">{{ it.openid ?? "-" }}</td>
              <td class="mono">{{ it.ip || "-" }}</td>
              <td class="mono">{{ formatTime(it.createdAt) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.admin-page {
  max-width: 860px;
  margin: 0 auto;
  padding: 32px 20px 64px;
  color: var(--text-color, #1f2937);
}
.admin-card {
  background: var(--card-bg, #fff);
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 12px;
  padding: 24px 28px;
}
.admin-card h1 {
  font-size: 22px;
  margin: 0 0 4px;
}
.admin-card .desc {
  color: var(--muted-color, #6b7280);
  font-size: 13px;
  margin: 0 0 16px;
}
.notice {
  padding: 10px 14px;
  border-radius: 8px;
  background: var(--bg-subtle, #f3f4f6);
  margin: 10px 0;
  font-size: 14px;
}
.notice.error {
  background: var(--danger-bg, #fef2f2);
  color: var(--danger-color, #dc2626);
  border: 1px solid var(--danger-border, #fecaca);
}
.mode-tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}
.mode-tab {
  padding: 6px 14px;
  border-radius: 999px;
  border: 1px solid var(--border-color, #e5e7eb);
  background: transparent;
  color: var(--text-secondary, #4b5563);
  cursor: pointer;
  font-size: 13px;
}
.mode-tab.active {
  background: var(--accent-bg, #2563eb);
  color: #fff;
  border-color: transparent;
}
.form-row {
  display: flex;
  gap: 8px;
}
.query-input {
  flex: 1;
  padding: 9px 12px;
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 8px;
  font-size: 14px;
  background: var(--input-bg, #fff);
  color: var(--text-color, #1f2937);
}
.days-select {
  padding: 9px 8px;
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 8px;
  font-size: 13px;
  background: var(--input-bg, #fff);
  color: var(--text-color, #1f2937);
}
.query-btn {
  padding: 9px 18px;
  border: none;
  border-radius: 8px;
  background: var(--accent-bg, #2563eb);
  color: #fff;
  font-size: 14px;
  cursor: pointer;
}
.query-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.result-head {
  margin: 14px 0 8px;
  font-size: 13px;
  color: var(--muted-color, #6b7280);
}
.table-wrap {
  overflow-x: auto;
  margin-top: 8px;
}
.result-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.result-table th,
.result-table td {
  text-align: left;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-color, #eee);
}
.result-table th {
  color: var(--muted-color, #6b7280);
  font-weight: 500;
  white-space: nowrap;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
</style>
