<template>
  <section class="admin-card">
    <div class="admin-card-head">
      <div>
        <h2>搜索记录</h2>
        <p class="admin-card-desc">谁搜了什么 / 某词谁搜过。可对异常 IP 一键加入黑名单。</p>
      </div>
    </div>

    <!-- 查询表单 -->
    <form class="admin-form" @submit.prevent="doSearch">
      <div class="admin-seg" role="tablist" aria-label="查询方式">
        <button
          type="button"
          :class="['admin-seg-item', { active: mode === 'openid' }]"
          @click="mode = 'openid'">按 openid 查</button>
        <button
          type="button"
          :class="['admin-seg-item', { active: mode === 'term' }]"
          @click="mode = 'term'">按搜索词查</button>
        <button
          type="button"
          :class="['admin-seg-item', { active: mode === 'ip' }]"
          @click="mode = 'ip'">按 IP 查</button>
      </div>
      <div class="admin-form-row">
        <input
          v-model="keyword"
          type="text"
          :placeholder="mode === 'openid' ? '输入 openid' : mode === 'term' ? '输入搜索词' : '输入 IP'"
          class="admin-input"
          @keyup.enter="doSearch" />
        <select v-model="days" class="admin-select" aria-label="时间范围">
          <option value="1">近 1 天</option>
          <option value="7">近 7 天</option>
          <option value="30">近 30 天</option>
          <option value="90">近 90 天</option>
        </select>
        <button type="submit" class="btn btn-primary" :disabled="loading || !keyword.trim()">
          {{ loading ? "查询中…" : "查询" }}
        </button>
      </div>
    </form>

    <p v-if="error" class="admin-notice admin-notice-error">{{ error }}</p>

    <!-- 结果区 -->
    <template v-if="searched">
      <div class="admin-list-head">
        <span>共 {{ total }} 条记录（{{ modeLabel }}：{{ lastKeyword }}）</span>
        <span class="admin-list-muted">第 {{ page }} / {{ totalPages }} 页 · 每页 {{ PAGE_SIZE }}</span>
      </div>

      <div v-if="loading" class="admin-state">查询中…</div>
      <div v-else-if="items.length === 0" class="admin-state">无记录（该时间范围内没有数据）</div>

      <div v-else class="admin-table-wrap">
        <table class="admin-table">
          <thead>
            <tr>
              <th>#</th>
              <th>搜索词</th>
              <th v-if="mode === 'term'">openid</th>
              <th v-if="mode === 'ip'">openid</th>
              <th>IP</th>
              <th>时间（北京时间）</th>
              <th class="th-op">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(it, idx) in items" :key="idx">
              <td class="mono">{{ (page - 1) * PAGE_SIZE + idx + 1 }}</td>
              <td class="cell-term">{{ it.term ?? "-" }}</td>
              <td v-if="mode === 'term' || mode === 'ip'" class="mono cell-openid">{{ it.openid ?? "-" }}</td>
              <td class="mono">{{ it.ip || "-" }}</td>
              <td class="mono">{{ formatTime(it.createdAt) }}</td>
              <td class="op-cell">
                <button
                  v-if="it.ip"
                  type="button"
                  class="btn btn-danger"
                  :disabled="busyKey !== ''"
                  @click="askBlock(it.ip)">
                  {{ busyKey === `block-${it.ip}` ? "拉黑中…" : "拉黑" }}
                </button>
                <span v-else class="admin-hint">-</span>
              </td>
            </tr>
          </tbody>
        </table>

        <!-- 分页 -->
        <div v-if="totalPages > 1" class="sr-pager">
          <button type="button" class="btn btn-neutral" :disabled="page <= 1 || loading" @click="goPage(page - 1)">
            ← 上一页
          </button>
          <span class="sr-pager-info">{{ page }} / {{ totalPages }}</span>
          <button type="button" class="btn btn-neutral" :disabled="page >= totalPages || loading" @click="goPage(page + 1)">
            下一页 →
          </button>
        </div>
      </div>
    </template>

    <!-- 确认弹窗（确认后执行拉黑） -->
    <AdminModal ref="modal" title="拉黑 IP" tone="danger" confirm-text="确认拉黑" />
  </section>
</template>

<script setup lang="ts">
/**
 * 搜索记录面板（2026-08-25 admin 规范化重构拆出的子组件）
 * 查询 /api/search-log：按 openid 或按词；结果行内"拉黑"调 /api/blacklist。
 */
import { useAdminApi, type SearchLogItem } from "~/composables/useAdminApi";
import AdminModal from "~/components/admin/AdminModal.vue";

const { querySearchLog, blockIp } = useAdminApi();
const { showToast } = useToast();
const modal = ref<InstanceType<typeof AdminModal>>();

const mode = ref<"openid" | "term" | "ip">("openid");
const keyword = ref("");
const days = ref("7");
const loading = ref(false);
const error = ref("");
const items = ref<SearchLogItem[]>([]);
const total = ref(0);
const searched = ref(false);
const lastKeyword = ref("");
const busyKey = ref("");
const page = ref(1);
const PAGE_SIZE = 50;
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));

/** 通知父层黑名单数据已变化（拉黑后联动刷新黑名单面板） */
const emit = defineEmits<{ (e: "blocked"): void }>();
const modeLabel = computed(() =>
  mode.value === "openid" ? "openid" : mode.value === "term" ? "搜索词" : "IP",
);

function formatTime(ms?: number): string {
  if (!ms) return "-";
  const d = new Date(ms + 8 * 3600 * 1000); // 北京时间
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

async function doSearch() {
  const kw = keyword.value.trim();
  if (!kw) return;
  page.value = 1;
  await doQuery();
}

async function doQuery() {
  const kw = keyword.value.trim();
  if (!kw) return;
  loading.value = true;
  error.value = "";
  try {
    const data = await querySearchLog({
      mode: mode.value,
      keyword: kw,
      days: days.value,
      limit: PAGE_SIZE,
      offset: (page.value - 1) * PAGE_SIZE,
    });
    items.value = data.items ?? [];
    total.value = data.total ?? items.value.length;
    lastKeyword.value = kw;
    searched.value = true;
  } catch (e: any) {
    error.value = e?.message || "请求异常";
  } finally {
    loading.value = false;
  }
}

function goPage(p: number) {
  if (p < 1 || p > totalPages.value) return;
  page.value = p;
  doQuery();
}

/** 弹确认框（替换 window.confirm），确认后执行拉黑 */
function askBlock(ip: string) {
  modal.value?.open({
    title: "拉黑 IP",
    message: `确定将 IP ${ip} 加入黑名单？\n立即封禁 30 天，该 IP 的搜索请求将被拦截。`,
    onConfirm: async () => {
      await doBlock(ip);
    },
  });
}

async function doBlock(ip: string) {
  if (busyKey.value) return;
  busyKey.value = `block-${ip}`;
  try {
    await blockIp(ip, "manual");
    // 本页剔除该 IP；若本页删空且非第 1 页则回退一页，再刷新
    items.value = items.value.filter((it) => it.ip !== ip);
    total.value = Math.max(0, total.value - 1);
    if (items.value.length === 0 && page.value > 1) page.value -= 1;
    showToast(`已拉黑 ${ip}`, "success");
    emit("blocked");
    await doQuery();
  } catch (e: any) {
    showToast(e?.message || "拉黑失败", "error");
    throw e; // 让 modal 保持打开显示错误
  } finally {
    busyKey.value = "";
  }
}
</script>

<style scoped>
.sr-pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 12px 0;
}
.sr-pager-info {
  font-size: 13px;
  color: var(--text-tertiary, #9ca3af);
  min-width: 60px;
  text-align: center;
}
</style>