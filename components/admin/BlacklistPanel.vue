<template>
  <section class="admin-card">
    <div class="admin-card-head">
      <div>
        <h2>IP 黑名单</h2>
        <p class="admin-card-desc">封禁中+惯犯档案+计数记录 · 顽固爬虫分级递增（24h → 7 天 → 30 天）</p>
      </div>
      <button type="button" class="btn btn-neutral" :disabled="loading" @click="refresh()">
        {{ loading ? "刷新中…" : "刷新" }}
      </button>
    </div>

    <!-- 筛选：IP 搜索 + 状态 -->
    <div class="admin-form-row" style="margin-bottom: 10px">
      <input
        v-model="ipFilter"
        type="text"
        class="admin-input"
        placeholder="按 IP 搜索（支持部分匹配）…"
        @keyup.enter="doFilter"
      />
      <select v-model="status" class="admin-select" aria-label="状态筛选" @change="doFilter">
        <option value="">全部</option>
        <option value="blocked">封禁中</option>
        <option value="free">已解封</option>
      </select>
      <button type="button" class="btn btn-neutral" @click="doFilter">筛选</button>
    </div>

    <p v-if="error" class="admin-notice admin-notice-error">{{ error }}</p>

    <div class="admin-list-head">
      <span>共 {{ total }} 条（{{ statusLabel }}）</span>
      <span class="admin-list-muted">{{ loading ? "加载中…" : `第 ${page} / ${totalPages} 页` }}</span>
    </div>

    <div v-if="loading && items.length === 0" class="admin-state">加载中…</div>
    <div v-else-if="items.length === 0 && !error" class="admin-state">暂无符合条件的记录</div>

    <div v-else class="admin-table-wrap">
      <table class="admin-table">
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
          <tr v-for="it in items" :key="it.ip">
            <td class="mono">{{ it.ip }}</td>
            <td>{{ reasonText[it.reason ?? ""] ?? it.reason }}</td>
            <td>
              <span :class="['badge', it.blocked ? 'badge-blocked' : 'badge-free']">
                {{ it.blocked ? "封禁中" : "已解封" }}
              </span>
            </td>
            <td>{{ blockLevelText(it.blockCount) }}</td>
            <td>{{ it.blocked ? formatDuration(it.remainingMs) : "-" }}</td>
            <td class="mono">{{ formatTime(it.expiresAt) }}</td>
            <td>{{ it.hitCount ?? 0 }}</td>
            <td class="mono">{{ formatTime(it.lastAt) }}</td>
            <td class="op-cell">
              <button
                type="button"
                class="btn btn-neutral"
                :disabled="busyKey !== ''"
                @click="askRemove(it.ip)">
                {{ busyKey === `remove-${it.ip}` ? "移除中…" : "移除" }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- 分页 -->
      <div v-if="totalPages > 1" class="bl-pager">
        <button type="button" class="btn btn-neutral" :disabled="page <= 1 || loading" @click="go(page - 1)">
          ← 上一页
        </button>
        <span class="bl-pager-info">{{ page }} / {{ totalPages }}</span>
        <button type="button" class="btn btn-neutral" :disabled="page >= totalPages || loading" @click="go(page + 1)">
          下一页 →
        </button>
      </div>
    </div>

    <!-- 确认弹窗 -->
    <AdminModal ref="modal" :title="'移除 IP'" tone="danger" confirm-text="确认移除" />
  </section>
</template>

<script setup lang="ts">
/**
 * IP 黑名单面板（2026-08-25 规范化重构拆出的子组件；2026-08-26 加筛选 + 分页）
 * 展示 /api/blacklist 封禁中 + 惯犯档案；"移除"即解除封禁。
 * - IP 模糊搜索 + 状态筛选（封禁中/已解封/全部）
 * - limit=50 分页
 */
import { useAdminApi, type BlacklistItem } from "~/composables/useAdminApi";
import AdminModal from "~/components/admin/AdminModal.vue";

const { loadBlacklist, removeIp } = useAdminApi();
const { showToast } = useToast();
const modalRef = ref<InstanceType<typeof AdminModal>>();

const loading = ref(false);
const error = ref("");
const items = ref<BlacklistItem[]>([]);
const total = ref(0);
const busyKey = ref("");

const ipFilter = ref("");
const status = ref<"" | "blocked" | "free">("");
const page = ref(1);
const PAGE_SIZE = 50;

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));
const statusLabel = computed(() =>
  status.value === "blocked" ? "封禁中" : status.value === "free" ? "已解封" : "全部",
);

const reasonText: Record<string, string> = {
  bot_ua: "爬虫UA",
  rate_limit: "限流",
  bad_term: "非法词",
  wx_auth: "未关注公众号",
  manual: "手动拉黑",
};

function blockLevelText(blockCount?: number): string {
  if (!blockCount) return "未拉黑";
  if (blockCount === 1) return "24 小时";
  if (blockCount === 2) return "7 天";
  return "30 天";
}

function formatDuration(ms?: number): string {
  if (!ms || ms <= 0) return "-";
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时`;
  return `${Math.floor(h / 24)} 天`;
}

function formatTime(ms?: number): string {
  if (!ms) return "-";
  const d = new Date(ms + 8 * 3600 * 1000); // 北京时间
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

async function load(opts?: { resetPage?: boolean }) {
  loading.value = true;
  error.value = "";
  if (opts?.resetPage) page.value = 1;
  try {
    const data = await loadBlacklist({
      limit: PAGE_SIZE,
      offset: (page.value - 1) * PAGE_SIZE,
      ip: ipFilter.value,
      status: status.value,
    });
    items.value = data.items ?? [];
    total.value = data.total ?? items.value.length;
  } catch (e: any) {
    error.value = e?.message || "请求异常";
  } finally {
    loading.value = false;
  }
}

/** 筛选变化 → 回到第 1 页重新拉 */
function doFilter() {
  load({ resetPage: true });
}

function go(p: number) {
  if (p < 1 || p > totalPages.value) return;
  page.value = p;
  load();
}

function askRemove(ip: string) {
  modalRef.value?.open({
    title: "移除 IP",
    message: `确定将 IP ${ip} 移出黑名单？\n将立即解除封禁（删除该 IP 的全部记录）。`,
    onConfirm: async () => {
      await doRemove(ip);
    },
  });
}

async function doRemove(ip: string) {
  if (busyKey.value) return;
  busyKey.value = `remove-${ip}`;
  try {
    await removeIp(ip);
    // 从当前结果剔除该 IP 的行；若本页删空且不是第一页则回退一页
    items.value = items.value.filter((it) => it.ip !== ip);
    total.value = Math.max(0, total.value - 1);
    if (items.value.length === 0 && page.value > 1) page.value -= 1;
    showToast(`已移除 ${ip}`, "success");
    await load();
  } catch (e: any) {
    showToast(e?.message || "移除失败", "error");
    throw e; // 让 modal 保持打开显示错误
  } finally {
    busyKey.value = "";
  }
}

// 首次进入自动加载
onMounted(() => load());

// 暴露给父组件（搜索记录拉黑后联动刷新）
defineExpose({ refresh: () => load() });
</script>

<style scoped>
.bl-pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 12px 0 4px;
}
.bl-pager-info {
  font-size: 13px;
  color: var(--text-tertiary, #9ca3af);
  min-width: 60px;
  text-align: center;
}
</style>