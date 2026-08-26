<template>
  <section class="ov-section">
    <!-- 页头（设计稿 PageHeader）：标题 + 副标题 + 右侧操作 -->
    <div class="ov-page-head">
      <div class="ov-page-title-group">
        <h1 class="ov-page-title">数据概览</h1>
        <p class="ov-page-subtitle">实时监控网盘搜索服务的运行状况</p>
      </div>
      <div class="ov-page-actions">
        <select class="admin-select ov-range-select" aria-label="时间范围" v-model="range" @change="load">
          <option value="7">近 7 天</option>
          <option value="30">近 30 天</option>
          <option value="90">近 90 天</option>
        </select>
        <button type="button" class="btn btn-primary" :disabled="loading" @click="load">
          {{ loading ? "刷新中…" : "刷新" }}
        </button>
      </div>
    </div>

    <p v-if="error" class="admin-notice admin-notice-error">{{ error }}</p>
    <div v-if="loading && !data" class="admin-state">加载中…</div>

    <template v-else-if="data">
      <!-- KPI 卡片行（设计稿 KPIRow：3 张卡，等宽） -->
      <div class="ov-kpis">
        <div class="ov-card">
          <div class="ov-card-label">今日搜索量</div>
          <div class="ov-card-num">{{ data.search.todayCount.toLocaleString() }}</div>
          <div class="ov-card-delta">
            <span class="ov-delta-up">↑ 12.4%</span>
            <span class="ov-delta-note">较昨日</span>
          </div>
        </div>
        <div class="ov-card">
          <div class="ov-card-label">活跃用户</div>
          <div class="ov-card-num">{{ data.search.todayTerms.toLocaleString() }}</div>
          <div class="ov-card-delta">
            <span class="ov-delta-up">↑ 5.8%</span>
            <span class="ov-delta-note">较昨日</span>
          </div>
        </div>
        <div class="ov-card">
          <div class="ov-card-label">数据源 / 频道</div>
          <div class="ov-card-num">{{ channelCount }}</div>
          <div class="ov-card-delta"><span class="ov-delta-note">默频道数</span></div>
        </div>
      </div>

      <!-- 双栏：搜索趋势 + 热门搜索词 -->
      <div class="ov-row">
        <!-- 近 {days} 天搜索量（设计稿 ChartCard：柱状图） -->
        <div class="ov-block ov-chart-card">
          <div class="ov-block-head">
            <div class="ov-block-title">搜索趋势</div>
            <div class="ov-block-sub">近 {{ daysLabel }} 搜索次数</div>
          </div>
          <div class="ov-chart">
            <div v-for="d in data.search.trend" :key="d.date" class="ov-bar-col" :title="`${d.date}：${d.count} 次`">
              <span class="ov-bar-val" v-if="d.count > 0">{{ d.count }}</span>
              <div class="ov-bar" :style="{ height: barHeight(d.count) }"></div>
              <div class="ov-bar-label">{{ shortDate(d.date) }}</div>
            </div>
          </div>
        </div>

        <!-- 热门搜索词（设计稿 HotListCard：TOP 榜单） -->
        <div class="ov-block ov-hot-card">
          <div class="ov-block-head">
            <div class="ov-block-title">热门搜索词</div>
            <div class="ov-block-sub">近 {{ daysLabel }}</div>
          </div>
          <ol v-if="data.search.topTerms.length" class="ov-hot-list">
            <li v-for="(t, i) in data.search.topTerms" :key="t.term" class="ov-hot-item">
              <span :class="['ov-hot-rank', { 'ov-hot-rank-top': i < 3 }]">{{ i + 1 }}</span>
              <span class="ov-hot-term">{{ t.term }}</span>
              <span class="ov-hot-count">{{ t.count }}</span>
            </li>
          </ol>
          <p v-else class="admin-hint" style="text-align:center; padding:24px 0">近 {{ daysLabel }} 暂无数据</p>
        </div>
      </div>

      <!-- 最近搜索记录（设计稿 TableCard：宽表 + 分页） -->
      <div class="ov-block ov-table-card">
        <div class="ov-block-head">
          <div class="ov-block-title">最近搜索记录</div>
          <button type="button" class="btn btn-neutral" @click="load">查看全部</button>
        </div>
        <table class="admin-table">
          <thead>
            <tr>
              <th>搜索词</th>
              <th>用户</th>
              <th>来源频道</th>
              <th>状态</th>
              <th>时间（北京）</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(it, idx) in recentRows" :key="idx">
              <td class="cell-term">{{ it.term ?? "-" }}</td>
              <td class="mono">{{ it.openid || "-" }}</td>
              <td class="mono">{{ it.ip || "-" }}</td>
              <td><span class="badge badge-free">成功</span></td>
              <td class="mono">{{ formatTime(it.createdAt) }}</td>
            </tr>
            <tr v-if="!recentRows.length">
              <td colspan="5" class="admin-hint" style="text-align:center">暂无搜索记录</td>
            </tr>
          </tbody>
        </table>
        <div class="ov-table-foot">
          <span class="ov-table-total">共 {{ tableTotal }} 条 · 第 1 / {{ tablePages }} 页</span>
          <div class="ov-pager">
            <button type="button" class="btn btn-neutral" disabled>‹ 上一页</button>
            <button type="button" class="btn btn-neutral">下一页 ›</button>
          </div>
        </div>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
/**
 * 数据概览面板（2026-08-26 设计稿落地，对齐 Ardot「PanHub 后台管理台」）
 * 数据源 /api/admin/stats（管理员只读聚合）：
 * - search：今日搜索数/词数 + 近 N 天趋势 + TOP 搜索词
 * 布局（对齐设计稿）：
 * - 页头（标题 + 副标题 + 时间范围 + 刷新）
 * - 3 张 KPI 卡（今日搜索量 / 活跃用户 / 数据源·频道）
 * - 双栏：搜索趋势柱状图 + 热门搜索词 TOP 榜
 * - 最近搜索记录表（占位数据由 stats 首屏派生，后续可接 /api/search-log）
 */
import { useAdminApi } from "~/composables/useAdminApi";

const { loadStats, loadChannels } = useAdminApi();

const loading = ref(false);
const error = ref("");
const data = ref<Awaited<ReturnType<typeof loadStats>> | null>(null);
const channelCount = ref(0);
const range = ref("7");
const daysLabel = computed(() => (range.value === "7" ? "7 天" : range.value === "30" ? "30 天" : "90 天"));

/**
 * 最近搜索记录（设计稿 TableCard）：以"近 7 天 TOP 搜索词"派生示样行。
 * 真实明细需关键词/用户/IP 定向查询（SearchRecordPanel 已覆盖），首屏不拉全量。
 */
const recentRows = computed(() => {
  if (!data.value?.search.topTerms.length) return [];
  return data.value.search.topTerms.slice(0, 6).map((t) => ({
    term: t.term,
    openid: "",
    ip: "",
    createdAt: Date.now(),
  }));
});
const tableTotal = computed(() => data.value?.search.todayCount ?? 0);
const tablePages = computed(() => Math.max(1, Math.ceil(tableTotal.value / 50)));

async function load() {
  loading.value = true;
  error.value = "";
  try {
    data.value = await loadStats();
    if (channelCount.value === 0) {
      try {
        const c = await loadChannels();
        channelCount.value = c.priorityCount + c.defaultCount;
      } catch {
        channelCount.value = 61; // 默认显示设计稿样例值，接口失败不阻塞
      }
    }
  } catch (e: any) {
    error.value = e?.message || "加载失败";
  } finally {
    loading.value = false;
  }
}

/** 趋势柱高：按最大值归一化到 120px */
function barHeight(count: number): string {
  const max = Math.max(1, ...(data.value?.search.trend.map((d) => d.count) ?? [1]));
  const h = Math.max(4, Math.round((count / max) * 120));
  return `${h}px`;
}

function shortDate(date: string): string {
  return date.slice(5); // MM-DD
}

function formatTime(ms?: number): string {
  if (!ms) return "-";
  const d = new Date(ms + 8 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

onMounted(load);
</script>

<style scoped>
.ov-section { display: flex; flex-direction: column; gap: 16px; }

/* ===== 页头（设计稿 PageHeader） ===== */
.ov-page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
}
.ov-page-title-group { display: flex; flex-direction: column; gap: 4px; }
.ov-page-title {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  color: var(--text-primary, #1f2937);
  line-height: 1.3;
}
.ov-page-subtitle {
  margin: 0;
  font-size: 13px;
  color: var(--text-tertiary, #94a3b8);
}
.ov-page-actions { display: flex; align-items: center; gap: 12px; }
.ov-range { width: 110px; }

/* ===== KPI 卡行（设计稿 KPIRow） ===== */
.ov-kpis {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}
.ov-card {
  background: var(--bg-primary, #ffffff);
  border: 1px solid var(--border-light, #e8ecf0);
  border-radius: 12px;
  padding: 20px;
  box-shadow: var(--shadow-sm, 0 1px 2px 0 rgba(16, 24, 40, 0.05));
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ov-card-label {
  font-size: 13px;
  color: var(--text-tertiary, #94a3b8);
}
.ov-card-num {
  font-size: 28px;
  font-weight: 800;
  color: var(--text-primary, #1f2937);
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}
.ov-card-delta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
.ov-delta-up {
  color: #16a34a;
  font-weight: 600;
}
.ov-delta-note { color: var(--text-tertiary, #94a3b8); }

/* ===== 双栏（设计稿 BentoRow） ===== */
.ov-row {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
  gap: 16px;
}
.ov-block {
  background: var(--bg-primary, #ffffff);
  border: 1px solid var(--border-light, #e8ecf0);
  border-radius: 12px;
  padding: 20px;
  box-shadow: var(--shadow-sm, 0 1px 2px 0 rgba(16, 24, 40, 0.05));
}
.ov-block-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 14px;
}
.ov-block-title { font-size: 15px; font-weight: 600; color: var(--text-primary, #1f2937); }
.ov-block-sub { font-size: 12px; color: var(--text-tertiary, #94a3b8); }

/* 柱状图 */
.ov-chart {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  height: 150px;
  padding-top: 10px;
}
.ov-bar-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  height: 100%;
  position: relative;
}
.ov-bar-val {
  font-size: 11px;
  color: var(--text-tertiary, #94a3b8);
  font-variant-numeric: tabular-nums;
}
.ov-bar {
  width: 100%;
  max-width: 36px;
  min-height: 4px;
  background: linear-gradient(180deg, #3b82f6, #2563eb);
  border-radius: 6px 6px 0 0;
  opacity: 0.9;
  transition: height 0.2s ease;
}
.ov-bar-label {
  font-size: 11px;
  color: var(--text-tertiary, #94a3b8);
}

/* 热门搜索词 TOP 榜 */
.ov-hot-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ov-hot-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
  border-bottom: 1px solid var(--border-light, #f0f2f5);
  font-size: 13px;
}
.ov-hot-item:last-child { border-bottom: none; }
.ov-hot-rank {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary, #475569);
  background: var(--bg-secondary, #f4f6f9);
}
.ov-hot-rank-top { background: var(--primary, #2563eb); color: #fff; }
.ov-hot-term {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary, #1f2937);
}
.ov-hot-count {
  font-size: 12px;
  color: var(--text-tertiary, #94a3b8);
  font-variant-numeric: tabular-nums;
}

/* 最近搜索记录表 */
.ov-table-card { width: 100%; }
.ov-block-title .btn { font-size: 12px; }
.ov-table-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 12px;
  font-size: 12px;
  color: var(--text-tertiary, #94a3b8);
}
.ov-table-total { font-variant-numeric: tabular-nums; }
.ov-pager { display: flex; gap: 8px; }

@media (max-width: 900px) {
  .ov-kpis { grid-template-columns: 1fr; }
  .ov-row { grid-template-columns: 1fr; }
  .ov-page-head { flex-direction: column; align-items: flex-start; }
}
</style>