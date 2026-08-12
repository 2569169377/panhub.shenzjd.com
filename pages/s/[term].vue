<template>
  <div class="s-page">
    <!-- 主内容 -->
    <header class="s-hero">
      <h1 class="s-title">{{ term }} 网盘资源搜索</h1>
      <p class="s-desc">
        在 PanHub 一键检索 {{ term }} 的网盘资源，聚合百度网盘、阿里云盘、夸克、115、迅雷、天翼云盘等平台分享链接，即搜即得。
      </p>
      <form class="s-search" @submit.prevent="onSubmit">
        <input
          v-model="kw"
          class="s-search__input"
          type="search"
          :placeholder="`搜索 ${term} 或其他网盘资源`"
          aria-label="搜索网盘资源" />
        <button class="s-search__btn" type="submit">搜索</button>
      </form>
    </header>

    <!-- 大家都在搜 -->
    <section v-if="related.length > 0" class="s-panel">
      <h2 class="s-panel__title">大家都在搜</h2>
      <div class="s-tags">
        <NuxtLink
          v-for="r in related"
          :key="r"
          :to="`/s/${encodeURIComponent(r)}`"
          class="s-tag">
          {{ r }}
        </NuxtLink>
      </div>
    </section>

    <!-- 搜索结果 -->
    <section class="s-panel">
      <h2 class="s-panel__title">{{ term }} 相关资源</h2>
      <ClientOnly>
        <div v-if="loading" class="s-state">
          <div class="spinner"></div>
          <span>正在检索 {{ term }} 的网盘资源…</span>
        </div>

        <div v-else-if="results.length > 0" class="s-results">
          <a
            v-for="(item, index) in results"
            :key="`${item.url || item.note}-${index}`"
            :href="item.url || item.link || '#'"
            target="_blank"
            rel="nofollow noopener noreferrer"
            class="s-result">
            <span class="s-result__platform">{{ item.platform || "网盘" }}</span>
            <span class="s-result__note">{{ item.note || item.title || item.name }}</span>
            <span v-if="item.datetime" class="s-result__date">{{ shortDate(item.datetime) }}</span>
          </a>
        </div>

        <div v-else-if="!loading && searched" class="s-state s-state--empty">
          <span>暂未找到 {{ term }} 的资源，试试其他关键词或稍后再来</span>
        </div>
        <template #fallback>
          <div class="s-state"><div class="spinner"></div><span>加载中…</span></div>
        </template>
      </ClientOnly>
    </section>

    <!-- 底部链接 -->
    <footer class="s-foot">
      <NuxtLink to="/" class="s-foot__link">PanHub 网盘搜索</NuxtLink>
      <span class="s-foot__dot">·</span>
      <NuxtLink to="/hot" class="s-foot__link">热搜趋势</NuxtLink>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";

const route = useRoute();
const config = useRuntimeConfig();
const siteUrl = (config.public?.siteUrl as string) || "";

const term = computed(() => {
  let t = String(route.params.term || "");
  try {
    t = decodeURIComponent(t);
  } catch {}
  return t.trim().slice(0, 50);
});

const kw = ref(term.value);
const results = ref<any[]>([]);
const loading = ref(false);
const searched = ref(false);

/* ---------- SEO ---------- */
useSeoMeta({
  title: () => `${term.value} 网盘资源 - 百度网盘/阿里云盘/夸克搜索`,
  description: () =>
    `在 PanHub 一键搜索 ${term.value} 的网盘资源，聚合百度网盘、阿里云盘、夸克、115、迅雷等平台分享链接，免费、快速、直达。`,
  ogTitle: () => `${term.value} 网盘资源搜索`,
  ogDescription: () => `聚合全网网盘平台的 ${term.value} 资源搜索`,
  ogType: "website",
});

useHead({
  link: [{ rel: "canonical", href: siteUrl ? `${siteUrl}/s/${encodeURIComponent(term.value)}` : `/s/${encodeURIComponent(term.value)}` }],
  script: [
    {
      type: "application/ld+json",
      innerHTML: JSON.stringify({
        "@context": "https://schema.org",
        "@type": "WebPage",
        name: `${term.value} 网盘资源搜索`,
        url: siteUrl ? `${siteUrl}/s/${encodeURIComponent(term.value)}` : `/s/${encodeURIComponent(term.value)}`,
        about: term.value,
        description: `聚合全网网盘平台的 ${term.value} 资源搜索，即搜即得。`,
      }),
    },
  ],
});

/* ---------- 相关热词（SSR 拉取，站内互链） ---------- */
const requestFetch = useRequestFetch();
const { data: hotData } = await useAsyncData<Array<{ term: string }>>(
  "s-related-terms",
  () =>
    requestFetch<{ code: number; data: { hotSearches: Array<{ term: string }> } }>(
      "/api/hot-searches?limit=30"
    ).then((r) => r?.data?.hotSearches ?? []),
  { default: () => [] }
);
const related = computed(() => {
  const list: string[] = (hotData.value ?? []).map((s) => s.term).filter(Boolean);
  return list.filter((t) => t !== term.value).slice(0, 10);
});

/* ---------- 搜索结果（客户端检索） ---------- */
async function doSearch() {
  if (!term.value) return;
  loading.value = true;
  searched.value = false;
  try {
    const res = await fetch(
      `/api/search?kw=${encodeURIComponent(term.value)}&res=merged_by_type`,
      { headers: { accept: "application/json" } }
    );
    if (!res.ok) {
      results.value = [];
      return;
    }
    const data = await res.json();
    const merged = data?.response?.merged_by_type ?? data?.response?.merged ?? {};
    const flat: any[] = [];
    for (const [platform, items] of Object.entries<any>(merged)) {
      for (const item of items || []) {
        flat.push({ ...item, platform });
      }
    }
    // 平铺去重后取前 30 条
    const seen = new Set<string>();
    results.value = flat
      .filter((i) => {
        const key = i.url || i.note || "";
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 30);
  } catch {
    results.value = [];
  } finally {
    loading.value = false;
    searched.value = true;
  }
}

function onSubmit() {
  const q = kw.value.trim();
  if (!q || q === term.value) return;
  navigateTo({ path: `/s/${encodeURIComponent(q)}` });
}

function shortDate(d: string): string {
  const t = new Date(d);
  if (isNaN(t.getTime())) return "";
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

watch(term, () => {
  kw.value = term.value;
  results.value = [];
  searched.value = false;
  doSearch();
});

onMounted(() => {
  doSearch();
});
</script>

<style scoped>
.s-page {
  display: flex;
  flex-direction: column;
  gap: 18px;
  animation: fadeIn 0.4s ease;
}

/* 头部 */
.s-hero {
  padding: 28px;
  background: var(--bg-surface);
  backdrop-filter: blur(8px);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-lg);
}

.s-title {
  margin: 0 0 10px;
  font-size: 26px;
  font-weight: 800;
  color: var(--text-primary);
  letter-spacing: -0.02em;
  word-break: break-all;
}

.s-desc {
  margin: 0 0 18px;
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.7;
}

.s-search {
  display: flex;
  gap: 10px;
}

.s-search__input {
  flex: 1;
  min-width: 0;
  padding: 11px 16px;
  border: 1px solid var(--border-light);
  background: var(--bg-input);
  border-radius: var(--radius-md);
  font-size: 14px;
  color: var(--text-primary);
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}

.s-search__input:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(15, 118, 110, 0.12);
}

.s-search__btn {
  flex-shrink: 0;
  padding: 11px 24px;
  border: none;
  background: linear-gradient(135deg, var(--primary), #0d9488);
  color: #fff;
  font-size: 14px;
  font-weight: 700;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: transform var(--transition-fast), box-shadow var(--transition-fast);
}

.s-search__btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(15, 118, 110, 0.28);
}

/* 面板 */
.s-panel {
  padding: 22px 24px;
  background: var(--bg-surface);
  backdrop-filter: blur(8px);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-lg);
}

.s-panel__title {
  margin: 0 0 14px;
  font-size: 15px;
  font-weight: 700;
  color: var(--text-primary);
}

/* 相关词 */
.s-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.s-tag {
  padding: 6px 14px;
  border: 1px solid var(--border-light);
  background: var(--bg-secondary);
  color: var(--text-primary);
  border-radius: 999px;
  font-size: 13px;
  text-decoration: none;
  transition: all var(--transition-fast);
}

.s-tag:hover {
  border-color: var(--primary);
  color: var(--primary);
  transform: translateY(-1px);
}

/* 结果列表 */
.s-results {
  display: flex;
  flex-direction: column;
}

.s-result {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 4px;
  border-bottom: 1px solid var(--border-light);
  text-decoration: none;
  transition: background-color var(--transition-fast);
  min-width: 0;
}

.s-result:last-child {
  border-bottom: none;
}

.s-result:hover {
  background: var(--bg-hover);
}

.s-result__platform {
  flex-shrink: 0;
  padding: 3px 8px;
  border-radius: var(--radius-sm);
  background: rgba(15, 118, 110, 0.1);
  color: var(--primary);
  font-size: 11px;
  font-weight: 700;
}

.s-result__note {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.s-result:hover .s-result__note {
  color: var(--primary);
}

.s-result__date {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text-tertiary);
}

/* 状态 */
.s-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 32px 16px;
  color: var(--text-secondary);
  font-size: 13px;
}

.s-state--empty {
  color: var(--text-tertiary);
}

.spinner {
  width: 20px;
  height: 20px;
  border: 3px solid rgba(15, 118, 110, 0.2);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* 底部 */
.s-foot {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 8px;
  padding: 8px 0 16px;
  font-size: 13px;
  color: var(--text-tertiary);
}

.s-foot__link {
  color: var(--primary);
  font-weight: 600;
  text-decoration: none;
}

.s-foot__link:hover {
  text-decoration: underline;
}

.s-foot__dot {
  color: var(--border-medium);
}

@media (max-width: 640px) {
  .s-hero {
    padding: 20px 16px;
  }

  .s-title {
    font-size: 22px;
  }

  .s-search {
    flex-direction: column;
  }

  .s-search__btn {
    width: 100%;
  }

  .s-panel {
    padding: 18px 16px;
  }
}
</style>
