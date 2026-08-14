<template>
  <div class="hot-page">
    <!-- 页头 -->
    <header class="page-hero">
      <div class="page-hero__content">
        <div class="badge">PanHub 热搜日历</div>
        <h1 class="title">每一天，大家在搜什么</h1>
        <p class="desc">按天记录全网用户的真实搜索词 · 点击日期查看当天全部搜索词 · 点击词条立即搜索</p>
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

    <!-- 日历热力图 -->
    <section class="panel calendar-panel">
      <div class="panel-head">
        <h2 class="panel-title">搜索日历</h2>
        <span class="panel-hint">最近 {{ days.length }} 天 · 颜色越深当天搜索词越多</span>
      </div>

      <ClientOnly>
        <div v-if="calendarLoading" class="panel-loading">
          <div class="spinner"></div>
          <span>日历加载中…</span>
        </div>

        <div v-else-if="days.length > 0" class="calendar-wrap">
          <button
            class="cal-arrow"
            type="button"
            :disabled="!canScrollLeft"
            aria-label="查看更早日期"
            title="查看更早日期"
            @click="scrollCalendar(-1)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
          </button>

          <div ref="calendarRef" class="calendar" @scroll="onCalendarScroll">
            <button
              v-for="d in days"
              :key="d.date"
              class="cal-cell"
              :class="[
                `cal-cell--${level(d.count)}`,
                { 'cal-cell--active': selected === d.date },
                { 'cal-cell--future': d.date > todayKey },
              ]"
              type="button"
              :title="cellTitle(d)"
              :aria-label="cellTitle(d)"
              @click="selectDate(d.date)">
              <span class="cal-cell__day">{{ dayOfMonth(d.date) }}</span>
              <span v-if="d.count > 0" class="cal-cell__count">{{ d.count }}</span>
            </button>
          </div>

          <button
            class="cal-arrow"
            type="button"
            :disabled="!canScrollRight"
            aria-label="查看更新日期"
            title="查看更新日期"
            @click="scrollCalendar(1)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
          </button>
        </div>

        <div v-else class="panel-empty">
          <p class="panel-empty__title">暂无日历数据</p>
          <p class="panel-empty__desc">当有用户开始搜索后，日历会自动记录</p>
        </div>
        <template #fallback>
          <div class="panel-loading"><div class="spinner"></div><span>加载中…</span></div>
        </template>
      </ClientOnly>

      <div class="calendar-legend">
        <span class="legend-item legend-item--0">少</span>
        <span v-for="i in 4" :key="i" class="legend-item" :class="`legend-item--${i}`" />
        <span class="legend-item">多</span>
      </div>
    </section>

    <!-- 当日词云 -->
    <section class="panel">
      <div class="panel-head">
        <h2 class="panel-title">{{ selectedTitle }}</h2>
        <div class="panel-actions">
          <span v-if="!dayLoading" class="panel-hint">共 {{ dayItems.length }} 个搜索词</span>
          <div class="view-toggle" role="group" aria-label="视图切换">
            <button
              :class="['view-btn', { active: view === 'cloud' }]"
              type="button"
              @click="view = 'cloud'">词云</button>
            <button
              :class="['view-btn', { active: view === 'list' }]"
              type="button"
              @click="view = 'list'">列表</button>
          </div>
        </div>
      </div>

      <ClientOnly>
        <div v-if="dayLoading" class="panel-loading">
          <div class="spinner"></div>
          <span>加载 {{ selected }} 的搜索词…</span>
        </div>

        <div v-else-if="dayItems.length > 0" class="day-body">
          <!-- 词云视图 -->
          <div v-if="view === 'cloud'" class="cloud">
            <button
              v-for="item in dayItems"
              :key="item.term"
              class="cloud-word"
              type="button"
              :style="wordStyle(item)"
              :title="`${item.term} · ${item.count} 次`"
              @click="quickSearch(item.term)">
              {{ item.term }}
            </button>
          </div>

          <!-- 列表视图 -->
          <div v-else class="chips">
            <button
              v-for="item in dayItems"
              :key="item.term"
              class="chip"
              type="button"
              @click="quickSearch(item.term)">
              <span class="chip__term">{{ item.term }}</span>
              <span class="chip__count">{{ item.count }}</span>
            </button>
          </div>
        </div>

        <div v-else class="panel-empty">
          <p class="panel-empty__title">这一天还没有搜索记录</p>
          <p class="panel-empty__desc">选择其他日期，或等待新的搜索产生</p>
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
import { ref, computed, nextTick } from "vue";

interface DayInfo {
  date: string;
  count: number;
  top: string[];
}

interface DayItem {
  term: string;
  rank: number;
  count: number;
}

useSeoMeta({
  title: "热搜日历 - PanHub 每日网盘热搜榜",
  description: "PanHub 热搜日历：按天查看全网用户的真实网盘搜索词，每一天的完整榜单。",
});

const days = ref<DayInfo[]>([]);
const dayItems = ref<DayItem[]>([]);
const selected = ref("");
const view = ref<"cloud" | "list">("cloud");
const calendarLoading = ref(false);
const dayLoading = ref(false);
const refreshing = ref(false);
const calendarRef = ref<HTMLElement | null>(null);
const canScrollLeft = ref(false);
const canScrollRight = ref(false);

const todayKey = computed(() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
});

const selectedTitle = computed(() => {
  if (!selected.value) return "当日搜索词";
  const [y, m, d] = selected.value.split("-");
  return `${y} 年 ${Number(m)} 月 ${Number(d)} 日`;
});

async function loadCalendar() {
  calendarLoading.value = true;
  try {
    const res = await fetch("/api/hot-calendar?days=30");
    const data = await res.json();
    days.value = data.code === 0 ? data.data.days : [];
    // 默认选中今天（日历最后一天）；今天无数据则选有数据的最近一天
    const today = todayKey.value;
    const hasToday = days.value.some((d) => d.date === today && d.count > 0);
    if (hasToday) {
      selected.value = today;
    } else {
      const last = [...days.value].reverse().find((d) => d.count > 0);
      selected.value = last ? last.date : today;
    }
  } catch {
    days.value = [];
  } finally {
    calendarLoading.value = false;
    // 等日历渲染后定位到最右（今天）
    await nextTick();
    scrollToToday();
    // 首次进入即加载选中日期数据（修复竞态：onMounted 时 loadCalendar 未完成）
    if (selected.value) await selectDate(selected.value);
  }
}

/* ---------- 日历横向滚动 ---------- */

function scrollCalendar(dir: -1 | 1) {
  const el = calendarRef.value;
  if (!el) return;
  el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: "smooth" });
}

function scrollToToday() {
  const el = calendarRef.value;
  if (!el) return;
  el.scrollLeft = el.scrollWidth;
  updateArrows();
}

function onCalendarScroll() {
  updateArrows();
}

function updateArrows() {
  const el = calendarRef.value;
  if (!el) return;
  const maxScroll = el.scrollWidth - el.clientWidth;
  canScrollLeft.value = el.scrollLeft > 4;
  canScrollRight.value = el.scrollLeft < maxScroll - 4;
}

async function selectDate(date: string) {
  if (date > todayKey.value) return;
  selected.value = date;
  dayLoading.value = true;
  try {
    const res = await fetch(`/api/hot-days?date=${date}`);
    const data = await res.json();
    dayItems.value = data.code === 0 ? data.data.items : [];
  } catch {
    dayItems.value = [];
  } finally {
    dayLoading.value = false;
  }
}

async function refresh() {
  refreshing.value = true;
  await loadCalendar();
  refreshing.value = false;
}

function quickSearch(term: string) {
  // 直接跳首页搜索（/?q=xxx），复用首页搜索体验，不再经过 /s 重定向
  navigateTo({ path: "/", query: { q: term } });
}

/* ---------- 日历渲染辅助 ---------- */

/** 按词数分 5 档（0-4），映射颜色深浅 */
function level(count: number): number {
  if (count <= 0) return 0;
  const max = Math.max(...days.value.map((d) => d.count), 1);
  const ratio = count / max;
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.25) return 2;
  return 1;
}

function dayOfMonth(date: string): string {
  return String(Number(date.split("-")[2]));
}

function cellTitle(d: DayInfo): string {
  const [y, m, day] = d.date.split("-");
  const base = `${y} 年 ${Number(m)} 月 ${Number(day)} 日`;
  if (d.count === 0) return `${base} · 无记录`;
  const top = d.top.length ? ` · ${d.top.join(" / ")}` : "";
  return `${base} · ${d.count} 个搜索词${top}`;
}

/* ---------- 词云样式 ---------- */

function wordStyle(item: DayItem): Record<string, string> {
  const maxCount = Math.max(...dayItems.value.map((i) => i.count), 1);
  const ratio = item.count / maxCount;
  // 字号 12px ~ 30px，热度越高越大
  const fontSize = 12 + Math.round(ratio * 18);
  // 前三名用醒目色，其余用主色系（越热越深）
  const color =
    item.rank <= 1 ? "#d97706" : item.rank <= 3 ? "#0f766e" : ratio > 0.4 ? "#115e59" : "#5f9c96";
  return { fontSize: `${fontSize}px`, color };
}

onMounted(() => {
  loadCalendar();
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

/* 面板 */
.panel {
  background: var(--bg-surface);
  backdrop-filter: blur(8px);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-lg);
  padding: 22px 24px;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.panel-title {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: var(--text-primary);
}

.panel-hint {
  font-size: 12px;
  color: var(--text-tertiary);
}

.panel-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* 视图切换 */
.view-toggle {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-sm);
}

.view-btn {
  padding: 4px 12px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
  border-radius: 6px;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.view-btn.active {
  background: var(--bg-primary);
  color: var(--primary);
  box-shadow: var(--shadow-sm);
}

/* 日历：单行横排 + 横向滚动 + 箭头 */
.calendar-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
}

.calendar {
  flex: 1;
  min-width: 0;
  display: flex;
  gap: 6px;
  overflow-x: auto;
  scroll-behavior: smooth;
  padding: 2px 0 6px;
  /* 隐藏滚动条但保留滚动能力 */
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.calendar::-webkit-scrollbar {
  display: none;
}

.cal-arrow {
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-light);
  background: var(--bg-secondary);
  color: var(--text-secondary);
  border-radius: 50%;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.cal-arrow:hover:not(:disabled) {
  background: var(--bg-primary);
  border-color: var(--primary);
  color: var(--primary);
}

.cal-arrow:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.cal-cell {
  flex: 0 0 52px;
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-height: 52px;
  padding: 6px 2px;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-sm);
  background: var(--bg-secondary);
  cursor: pointer;
  transition: transform var(--transition-fast), box-shadow var(--transition-fast);
}

.cal-cell:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-md);
}

.cal-cell--active {
  border: 2px solid var(--primary);
  box-shadow: 0 0 0 3px rgba(15, 118, 110, 0.15);
}

.cal-cell--future {
  opacity: 0.4;
  cursor: not-allowed;
}

.cal-cell--0 {
  background: var(--bg-secondary);
}

.cal-cell--1 {
  background: rgba(15, 118, 110, 0.18);
  border-color: rgba(15, 118, 110, 0.3);
}

.cal-cell--2 {
  background: rgba(15, 118, 110, 0.38);
  border-color: rgba(15, 118, 110, 0.45);
}

.cal-cell--3 {
  background: rgba(15, 118, 110, 0.62);
  border-color: rgba(15, 118, 110, 0.7);
}

.cal-cell--4 {
  background: rgba(15, 118, 110, 0.88);
  border-color: #0f766e;
}

.cal-cell--1 .cal-cell__day,
.cal-cell--2 .cal-cell__day,
.cal-cell--3 .cal-cell__day,
.cal-cell--4 .cal-cell__day {
  color: #fff;
  font-weight: 700;
}

.cal-cell--0 .cal-cell__day {
  color: var(--text-tertiary);
}

.cal-cell__day {
  font-size: 13px;
  color: var(--text-primary);
}

.cal-cell__count {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.85);
}

.cal-cell--0 .cal-cell__count {
  color: transparent;
}

/* 图例 */
.calendar-legend {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  margin-top: 14px;
}

.legend-item {
  width: 14px;
  height: 14px;
  border-radius: 4px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
  font-size: 10px;
  color: var(--text-tertiary);
  display: flex;
  align-items: center;
  justify-content: center;
}

.legend-item--1 { background: rgba(15, 118, 110, 0.18); }
.legend-item--2 { background: rgba(15, 118, 110, 0.38); }
.legend-item--3 { background: rgba(15, 118, 110, 0.62); }
.legend-item--4 { background: rgba(15, 118, 110, 0.88); }

.legend-item:first-child,
.legend-item:last-child {
  width: auto;
  background: transparent;
  border: none;
  padding: 0 4px;
}

/* 词云 */
.day-body {
  min-height: 80px;
}

.cloud {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 10px 16px;
  padding: 16px 4px;
}

.cloud-word {
  border: none;
  background: transparent;
  font-weight: 700;
  line-height: 1.3;
  cursor: pointer;
  padding: 2px 4px;
  transition: opacity var(--transition-fast), transform var(--transition-fast);
}

.cloud-word:hover {
  opacity: 0.75;
  transform: scale(1.06);
}

/* 列表视图 */
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 0;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid var(--border-light);
  background: var(--bg-secondary);
  color: var(--text-primary);
  border-radius: 999px;
  font-size: 13px;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.chip:hover {
  border-color: var(--primary);
  color: var(--primary);
  transform: translateY(-1px);
}

.chip__term {
  font-weight: 500;
}

.chip__count {
  font-size: 11px;
  font-weight: 700;
  color: var(--primary);
  background: rgba(15, 118, 110, 0.1);
  border-radius: 999px;
  padding: 1px 7px;
}

/* 加载/空状态 */
.panel-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 40px 20px;
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

.panel-empty {
  padding: 40px 20px;
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

  .panel {
    padding: 16px;
  }

  .calendar {
    gap: 4px;
  }

  .cal-cell {
    flex-basis: 44px;
    min-height: 44px;
  }

  .cal-arrow {
    width: 30px;
    height: 30px;
  }
}
</style>
