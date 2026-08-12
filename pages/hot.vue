<template>
  <div class="hot-page">
    <!-- 页头 -->
    <header class="page-hero">
      <div class="page-hero__content">
        <div class="badge">PanHub 热搜趋势</div>
        <h1 class="title">大家都在搜什么</h1>
        <p class="desc">基于全网用户的真实搜索行为 · 榜单每日更新 · 点击词条立即搜索</p>
      </div>
      <button
        class="refresh-btn"
        type="button"
        :disabled="refreshing"
        @click="refresh">
        <span v-if="refreshing" class="spinner-sm"></span>
        {{ refreshing ? "更新中…" : "刷新" }}
      </button>
    </header>

    <!-- Tab 切换 -->
    <div class="tabs" role="tablist">
      <button
        :class="['tab', { active: tab === 'trending' }]"
        role="tab"
        type="button"
        @click="tab = 'trending'">
        飙升榜
      </button>
      <button
        :class="['tab', { active: tab === 'ranking' }]"
        role="tab"
        type="button"
        @click="tab = 'ranking'">
        完整榜单
      </button>
    </div>

    <!-- 飙升榜 -->
    <section v-if="tab === 'trending'" class="panel">
      <ClientOnly>
        <div v-if="trendingLoading" class="panel-loading">
          <div class="spinner"></div>
          <span>飙升榜加载中…</span>
        </div>

        <div v-else-if="trending.length > 0" class="list">
          <button
            v-for="(item, index) in trending"
            :key="item.term"
            class="list-item"
            type="button"
            @click="quickSearch(item.term)">
            <span class="rank" :class="`rank-${Math.min(index + 1, 3)}`">{{ index + 1 }}</span>
            <span class="term">{{ item.term }}</span>
            <span :class="['delta', deltaClass(item)]">{{ deltaText(item) }}</span>
            <span class="score">{{ formatScore(item.score) }}</span>
          </button>
        </div>

        <div v-else class="panel-empty">
          <p class="panel-empty__title">暂无飙升数据</p>
          <p class="panel-empty__desc">明日访问即可对比今日榜单，看到词条的排名变化</p>
        </div>
        <template #fallback>
          <div class="panel-loading"><div class="spinner"></div><span>加载中…</span></div>
        </template>
      </ClientOnly>
    </section>

    <!-- 完整榜单 -->
    <section v-else class="panel">
      <ClientOnly>
        <div v-if="rankingLoading" class="panel-loading">
          <div class="spinner"></div>
          <span>榜单加载中…</span>
        </div>

        <div v-else-if="ranking.length > 0" class="list">
          <button
            v-for="(item, index) in ranking"
            :key="item.term"
            class="list-item"
            type="button"
            @click="quickSearch(item.term)">
            <span class="rank" :class="`rank-${Math.min(index + 1, 3)}`">{{ index + 1 }}</span>
            <span class="term">{{ item.term }}</span>
            <span class="heat">
              <span class="heat__bar" :style="{ width: `${item.heatPercent || 0}%` }" />
            </span>
            <span class="score">{{ formatScore(item.displayScore ?? item.score) }}</span>
          </button>
        </div>

        <div v-else class="panel-empty">
          <p class="panel-empty__title">暂无榜单数据</p>
          <p class="panel-empty__desc">当有用户开始搜索后，榜单会自动生成</p>
        </div>
        <template #fallback>
          <div class="panel-loading"><div class="spinner"></div><span>加载中…</span></div>
        </template>
      </ClientOnly>
    </section>

    <footer class="page-foot">
      返回
      <NuxtLink to="/" class="page-foot__link">PanHub 网盘搜索</NuxtLink>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";

interface TrendingItem {
  term: string;
  rank: number;
  prevRank: number | null;
  delta: number;
  score: number;
}

interface RankingItem {
  term: string;
  rank?: number;
  score: number;
  displayScore?: number;
  heatPercent?: number;
}

useSeoMeta({
  title: "热搜趋势 - PanHub 网盘热搜榜",
  description: "PanHub 热搜趋势：全网网盘搜索飙升榜与完整榜单，基于真实用户搜索行为，每日更新。",
});

const tab = ref<"trending" | "ranking">("trending");
const trending = ref<TrendingItem[]>([]);
const ranking = ref<RankingItem[]>([]);
const trendingLoading = ref(false);
const rankingLoading = ref(false);
const refreshing = ref(false);

async function loadTrending() {
  trendingLoading.value = true;
  try {
    const res = await fetch("/api/hot-trends?limit=20");
    const data = await res.json();
    trending.value = data.code === 0 ? data.data.items : [];
  } catch {
    trending.value = [];
  } finally {
    trendingLoading.value = false;
  }
}

async function loadRanking() {
  rankingLoading.value = true;
  try {
    const res = await fetch("/api/hot-searches?limit=50");
    const data = await res.json();
    ranking.value = data.code === 0 ? data.data.hotSearches : [];
  } catch {
    ranking.value = [];
  } finally {
    rankingLoading.value = false;
  }
}

async function refresh() {
  refreshing.value = true;
  await Promise.all([loadTrending(), loadRanking()]);
  refreshing.value = false;
}

function quickSearch(term: string) {
  // 跳转 SEO 落地页（自动检索该词，站内互链利于收录）
  navigateTo({ path: `/s/${encodeURIComponent(term)}` });
}

function deltaClass(item: TrendingItem): string {
  if (item.prevRank === null) return "delta--new";
  if (item.delta > 0) return "delta--up";
  if (item.delta < 0) return "delta--down";
  return "delta--flat";
}

function deltaText(item: TrendingItem): string {
  if (item.prevRank === null) return "新上榜";
  if (item.delta > 0) return `↑${item.delta}`;
  if (item.delta < 0) return `↓${-item.delta}`;
  return "持平";
}

function formatScore(score: number): string {
  if (!score || score <= 0) return "-";
  return score >= 100 ? Math.round(score).toString() : score.toFixed(1);
}

onMounted(() => {
  loadTrending();
  loadRanking();
});
</script>

<style scoped>
.hot-page {
  display: flex;
  flex-direction: column;
  gap: 20px;
  animation: fadeIn 0.4s ease;
}

/* 页头 */
.page-hero {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 24px 28px;
  background: var(--bg-surface);
  backdrop-filter: blur(8px);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-lg);
}

.badge {
  display: inline-block;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--primary);
  padding: 5px 10px;
  background: rgba(15, 118, 110, 0.1);
  border: 1px solid rgba(15, 118, 110, 0.2);
  border-radius: var(--radius-sm);
  margin-bottom: 10px;
}

.title {
  margin: 0 0 8px;
  font-size: 26px;
  font-weight: 800;
  color: var(--text-primary);
  letter-spacing: -0.02em;
}

.desc {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.6;
}

.refresh-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border: 1px solid var(--border-light);
  background: var(--bg-secondary);
  color: var(--text-primary);
  border-radius: var(--radius-md);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.refresh-btn:hover:not(:disabled) {
  background: var(--bg-primary);
  border-color: var(--primary);
  color: var(--primary);
}

.refresh-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.spinner-sm {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(15, 118, 110, 0.2);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

/* Tab */
.tabs {
  display: inline-flex;
  gap: 4px;
  padding: 4px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-md);
  align-self: flex-start;
}

.tab {
  padding: 7px 18px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 600;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.tab:hover {
  color: var(--primary);
}

.tab.active {
  background: var(--bg-primary);
  color: var(--primary);
  box-shadow: var(--shadow-sm);
}

/* 面板 */
.panel {
  background: var(--bg-surface);
  backdrop-filter: blur(8px);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-lg);
  overflow: hidden;
}

.panel-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 48px 20px;
  color: var(--text-secondary);
  font-size: 13px;
}

.spinner {
  width: 22px;
  height: 22px;
  border: 3px solid rgba(15, 118, 110, 0.2);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* 列表 */
.list {
  display: flex;
  flex-direction: column;
}

.list-item {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  padding: 11px 20px;
  border: none;
  border-bottom: 1px solid var(--border-light);
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  transition: background-color var(--transition-fast);
  text-align: left;
}

.list-item:last-child {
  border-bottom: none;
}

.list-item:hover {
  background: var(--bg-hover);
}

.rank {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  color: var(--text-tertiary);
  background: var(--bg-secondary);
  border-radius: var(--radius-sm);
}

.rank-1 {
  color: #fff;
  background: linear-gradient(135deg, #f59e0b, #fbbf24);
}

.rank-2 {
  color: #fff;
  background: linear-gradient(135deg, #94a3b8, #cbd5e1);
}

.rank-3 {
  color: #fff;
  background: linear-gradient(135deg, #b45309, #d97706);
}

.term {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 飙升 delta 徽标 */
.delta {
  flex-shrink: 0;
  min-width: 52px;
  text-align: center;
  padding: 3px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
}

.delta--new {
  color: #d97706;
  background: rgba(245, 158, 11, 0.12);
  border: 1px solid rgba(245, 158, 11, 0.3);
}

.delta--up {
  color: #ef4444;
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.25);
}

.delta--down {
  color: #10b981;
  background: rgba(16, 185, 129, 0.08);
  border: 1px solid rgba(16, 185, 129, 0.25);
}

.delta--flat {
  color: var(--text-tertiary);
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
}

/* 热度条 */
.heat {
  flex-shrink: 0;
  width: 110px;
  height: 6px;
  background: var(--bg-secondary);
  border-radius: 999px;
  overflow: hidden;
}

.heat__bar {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, var(--primary), #14b8a6);
  border-radius: 999px;
  transition: width 0.4s ease;
}

.score {
  flex-shrink: 0;
  min-width: 44px;
  text-align: right;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

/* 空状态 */
.panel-empty {
  padding: 48px 20px;
  text-align: center;
}

.panel-empty__title {
  margin: 0 0 6px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.panel-empty__desc {
  margin: 0;
  font-size: 13px;
  color: var(--text-tertiary);
}

/* 页脚 */
.page-foot {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 4px;
  padding: 8px 0 16px;
  font-size: 13px;
  color: var(--text-tertiary);
}

.page-foot__link {
  color: var(--primary);
  font-weight: 600;
  text-decoration: none;
}

.page-foot__link:hover {
  text-decoration: underline;
}

@media (max-width: 640px) {
  .page-hero {
    padding: 18px 16px;
    flex-direction: column;
  }

  .title {
    font-size: 22px;
  }

  .refresh-btn {
    width: 100%;
    justify-content: center;
  }

  .list-item {
    padding: 10px 14px;
    gap: 10px;
  }

  .heat {
    width: 60px;
  }

  .delta {
    min-width: 46px;
  }
}
</style>
