<template>
  <section class="admin-card">
    <div class="admin-card-head">
      <div>
        <h2>流量概览</h2>
        <p class="admin-card-desc">今日真实搜索 / 拦截态势 · 数据来源于 search_log 与 rejected_ips</p>
      </div>
      <button type="button" class="btn btn-neutral" :disabled="loading" @click="load">
        {{ loading ? "加载中…" : "刷新" }}
      </button>
    </div>

    <p v-if="error" class="admin-notice admin-notice-error">{{ error }}</p>
    <div v-if="loading && !data" class="admin-state">加载中…</div>

    <template v-else-if="data">
      <!-- 统计卡片行 -->
      <div class="ov-cards">
        <div class="ov-card">
          <div class="ov-card-num">{{ data.search.todayCount }}</div>
          <div class="ov-card-label">今日搜索次数</div>
        </div>
        <div class="ov-card">
          <div class="ov-card-num">{{ data.search.todayTerms }}</div>
          <div class="ov-card-label">今日去重词数</div>
        </div>
        <div class="ov-card">
          <div class="ov-card-num" :class="{ 'ov-num-warn': data.defense.blocked > 0 }">{{ data.defense.blocked }}</div>
          <div class="ov-card-label">封禁中 IP（共 {{ data.defense.total }} 条档案）</div>
        </div>
        <div class="ov-card">
          <div class="ov-card-num" :class="{ 'ov-num-warn': data.defense.todayActive > 0 }">{{ data.defense.todayActive }}</div>
          <div class="ov-card-label">今日活跃被拒 IP</div>
        </div>
      </div>

      <!-- 近 7 天趋势（极简柱状） -->
      <div class="ov-block">
        <div class="ov-block-title">近 7 天搜索量</div>
        <div class="ov-bars">
          <div v-for="d in data.search.trend" :key="d.date" class="ov-bar-col" :title="`${d.date}：${d.count} 次`">
            <div class="ov-bar" :style="{ height: barHeight(d.count) }"></div>
            <div class="ov-bar-label">{{ shortDate(d.date) }}</div>
          </div>
        </div>
      </div>

      <div class="ov-cols">
        <!-- 近 7 天 TOP 搜索词 -->
        <div class="ov-block ov-col">
          <div class="ov-block-title">近 7 天 TOP 搜索词</div>
          <table class="admin-table">
            <thead>
              <tr><th>#</th><th>搜索词</th><th class="th-op">次数</th></tr>
            </thead>
            <tbody>
              <tr v-for="(t, i) in data.search.topTerms" :key="t.term">
                <td class="mono">{{ i + 1 }}</td>
                <td class="cell-term">{{ t.term }}</td>
                <td class="op-cell mono">{{ t.count }}</td>
              </tr>
              <tr v-if="data.search.topTerms.length === 0">
                <td colspan="3" class="admin-hint" style="text-align:center">近 7 天暂无数据</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 近 7 天活跃被拒 IP -->
        <div class="ov-block">
          <div class="ov-block-title">近 7 天活跃被拒 IP</div>
          <table class="admin-table">
            <thead>
              <tr><th>IP</th><th>原因</th><th class="th-op">累计拒绝</th><th class="th-op">状态</th></tr>
            </thead>
            <tbody>
              <tr v-for="it in data.defense.topIps" :key="it.ip">
                <td class="mono">{{ it.ip }}</td>
                <td>{{ reasonText[it.reason] ?? it.reason }}</td>
                <td class="op-cell mono">{{ it.hitCount }}</td>
                <td class="op-cell">
                  <span :class="['badge', it.expiresAt > now ? 'badge-blocked' : 'badge-free']">
                    {{ it.expiresAt > now ? "封禁中" : "已解封" }}
                  </span>
                </td>
              </tr>
              <tr v-if="data.defense.topIps.length === 0">
                <td colspan="4" class="empty-hint" style="text-align:center">近 7 天无被拒 IP</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
/**
 * 流量概览面板（2026-08-26）
 * 数据源 /api/admin/stats（管理员只读聚合）：
 * - search：今日搜索数/词数 + 近 7 天趋势 + TOP 搜索词
 * - defense：黑名单档案/封禁中/今日活跃 + 近 7 天活跃被拒 IP
 * 把"日志人肉 grep"变成一眼可看的管理页。
 */
import { useAdminApi } from "~/composables/useAdminApi";

const { loadStats } = useAdminApi();

const loading = ref(false);
const error = ref("");
const data = ref<Awaited<ReturnType<typeof loadStats>> | null>(null);
const now = ref(Date.now());

const reasonText: Record<string, string> = {
  bot_ua: "爬虫UA",
  rate_limit: "限流",
  bad_term: "非法词",
  wx_auth: "未关注公众号",
  manual: "手动拉黑",
  probe: "持续探查",
};

async function load() {
  loading.value = true;
  error.value = "";
  try {
    data.value = await loadStats();
    now.value = Date.now();
  } catch (e: any) {
    error.value = e?.message || "加载失败";
  } finally {
    loading.value = false;
  }
}

/** 趋势柱高：按最大值归一化到 80px */
function barHeight(count: number): string {
  const max = Math.max(1, ...data.value?.search.trend.map((d) => d.count) ?? [1]);
  const h = Math.max(4, Math.round((count / max) * 80));
  return `${h}px`;
}

function shortDate(date: string): string {
  return date.slice(5); // MM-DD
}

onMounted(load);
</script>

<style scoped>
.ov-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
  margin-bottom: 18px;
}
.ov-card {
  background: var(--bg-secondary, #f7f3ea);
  border: 1px solid var(--border-light, #e5dfd0);
  border-radius: 12px;
  padding: 14px 16px;
}
.ov-card-num {
  font-size: 28px;
  font-weight: 800;
  color: var(--primary, #0f766e);
  font-variant-numeric: tabular-nums;
}
.ov-card-num.ov-num-warn { color: var(--error, #ef4444); }
.ov-card-label {
  margin-top: 4px;
  font-size: 12.5px;
  color: var(--text-tertiary, #9ca3af);
}
.ov-block {
  border: 1px solid var(--border-light, #e5dfd0);
  border-radius: 12px;
  padding: 14px 16px;
  margin-bottom: 14px;
}
.ov-block-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary, #4b5563);
  margin-bottom: 10px;
}
.ov-cols {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 14px;
}
/* 柱状图 */
.ov-bars {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  height: 104px;
  padding-top: 6px;
}
.ov-bar-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  height: 100%;
  justify-content: flex-end;
}
.ov-bar {
  width: 100%;
  max-width: 34px;
  min-height: 4px;
  background: var(--primary, #0f766e);
  border-radius: 4px 4px 0 0;
  opacity: 0.85;
  transition: height 0.2s ease;
}
.ov-bar-date {
  font-size: 11px;
  color: var(--text-tertiary, #9ca3af);
}
.empty-hint { color: var(--text-tertiary, #9ca3af); }
</style>