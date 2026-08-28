<template>
  <div class="admin-shell">
    <!-- 遮罩（移动端抽屉打开时） -->
    <div v-if="menuOpen" class="admin-mask" @click="menuOpen = false" />

    <div class="admin-body">
      <!-- 侧栏（桌面常驻 / 移动端抽屉）：固定在左侧，不随内容滚动 -->
      <aside :class="['admin-sidebar', { open: menuOpen }]">
        <!-- 品牌（设计稿：渐变 Logo + 名称） -->
        <NuxtLink to="/" class="admin-brand" title="返回首页">
          <span class="admin-brand-badge">
            <img
              src="https://cdn.jsdmirror.com/gh/wu529778790/img.shenzjd.com@master/blog/imgx-20260828-151509-5bk7.svg"
              alt="PanHub"
              class="admin-brand-logo"
            />
          </span>
          <span class="admin-brand-name">PanHub 管理后台</span>
        </NuxtLink>

        <div class="admin-side-title">管理后台</div>

        <nav class="admin-menu">
          <template v-for="group in MENU_GROUPS" :key="group.label">
            <div v-if="group.label" class="admin-menu-group">{{ group.label }}</div>
            <button
              v-for="item in group.items"
              :key="item.key"
              type="button"
              :class="['admin-menu-item', { active: item.key === activeKey }]"
              @click="setActive(item.key)">
              <!-- 设计稿线性图标（现有 emoji 图标升级为 SVG 路径） -->
              <svg class="admin-menu-icon" viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path :d="item.icon" />
              </svg>
              <span>{{ item.label }}</span>
            </button>
          </template>
        </nav>

        <div class="admin-side-foot">v2 · 2026-08-26 设计稿</div>
      </aside>

      <!-- 主区（顶栏 + 内容） -->
      <div class="admin-main">
        <!-- 顶栏（设计稿：64px 白底；全局搜索 + 铃铛 + 用户菜单） -->
        <header class="admin-topbar">
          <label class="admin-global-search">
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" />
              <path d="m10.5 10.5 3 3" />
            </svg>
            <input type="search" placeholder="搜索功能、频道、用户…" aria-label="全局搜索" />
          </label>

          <div class="admin-topbar-right">
            <button type="button" class="admin-icon-btn" aria-label="通知">
              <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M9 2.5a5 5 0 0 0-5 5v2.2l-1 2.3h12l-1-2.3V7.5a5 5 0 0 0-5-5Z" />
                <path d="M7 14.5a2 2 0 0 0 4 0" />
              </svg>
            </button>
            <div class="admin-user-menu">
              <span class="admin-user-avatar">沈</span>
              <span class="admin-user-name">沈经理</span>
            </div>
          </div>
        </header>

        <!-- 内容区（唯一滚动区） -->
        <main class="admin-content">
          <div class="admin-crumb">
            <span class="admin-crumb-root">PanHub</span>
            <span class="admin-crumb-sep">/</span>
            <span class="admin-crumb-current">{{ currentLabel }}</span>
          </div>

          <slot />
        </main>
      </div>
    </div>

    <!-- 移动端：无顶栏，悬浮汉堡开抽屉 -->
    <button
      v-if="isMobile && !menuOpen"
      type="button"
      class="admin-burger-fab"
      aria-label="打开菜单"
      @click="menuOpen = true">☰</button>
  </div>
</template>

<script setup lang="ts">
import { ADMIN_NAV_KEY } from "~/utils/adminKeys";

/**
 * 管理后台规范化布局（2026-08-25 v2 重构；2026-08-26 设计稿落地）
 * 结构：顶栏（全局搜索 + 铃铛 + 用户菜单）+ 左侧分组菜单 + 内容区。
 *
 * 与页面的协作（provide/inject 共享响应式 ref，键见 ~/utils/adminKeys）：
 * - activeKey：当前激活菜单（布局渲染高亮/面包屑，页面据此渲染面板）
 * - setActive：切换菜单
 */
interface AdminMenuItem {
  key: string;
  label: string;
  icon: string; // SVG path
}
interface AdminMenuGroup {
  label?: string;
  items: AdminMenuItem[];
}

/** 菜单分组（新增功能往这里加；页面面板须与 key 对应渲染） */
const MENU_GROUPS: AdminMenuGroup[] = [
  {
    label: "概览",
    items: [
      { key: "overview", label: "控制台", icon: "M2 9.5 9 3.5l7 6-.8 1.1h-1v5H10v-3.5H8V15.6H3.8v-5h-.8L3 9.5Z" },
    ],
  },
  {
    label: "管理",
    items: [
      { key: "channels", label: "搜索源管理", icon: "M2 5.5h14M2 12.5h14M5.5 3v5M12.5 10v5M5 5.5h.01M13 12.5h.01" },
      { key: "search-log", label: "搜索记录", icon: "M3 3h12M3 8h12M3 13h12M6 5h.01M6 10h.01M6 15h.01" },
    ],
  },
  {
    label: "防护",
    items: [
      { key: "blacklist", label: "IP 黑名单", icon: "M3 6h12M3 12h12M9 5v2M9 11v2" },
    ],
  },
];

const activeKey = ref<string>("overview");
const menuOpen = ref(false);
const isMobile = ref(false);

/** 当前激活菜单项（面包屑） */
const currentLabel = computed(
  () => MENU_GROUPS.flatMap((g) => g.items).find((m) => m.key === activeKey.value)?.label || "管理后台",
);

function setActive(key: string) {
  activeKey.value = key;
  menuOpen.value = false;
}

function onResize() {
  isMobile.value = typeof window !== "undefined" && window.innerWidth < 900;
  if (!isMobile.value) menuOpen.value = false;
}

onMounted(() => {
  onResize();
  window.addEventListener("resize", onResize);
});
onBeforeUnmount(() => window.removeEventListener("resize", onResize));

// 提供给页面：切换菜单
provide(ADMIN_NAV_KEY, { activeKey, setActive });
</script>

<style scoped>
/* ===== 外壳 ===== */
.admin-shell {
  height: 100vh;
  overflow: hidden;
  display: flex;
  color: var(--text-primary, #1f2937);
  background: var(--bg-secondary, #f4f6f9);
}

/* 遮罩（移动端抽屉） */
.admin-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 120;
}

/* ===== 主体 ===== */
.admin-body {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
}

/* ===== 侧栏（固定，整屏高度，内部滚动） ===== */
.admin-sidebar {
  width: 248px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow-y: auto;
  padding: 16px 12px;
  background: var(--bg-primary, #ffffff);
  border-right: 1px solid var(--border-light, #e8ecf0);
}
.admin-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  text-decoration: none;
  color: var(--text-primary, #1f2937);
  padding: 4px 10px 14px;
  border-bottom: 1px solid var(--border-light, #e8ecf0);
  margin-bottom: 12px;
}
.admin-brand-badge {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: #fff;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  box-shadow: 0 2px 6px rgba(15, 118, 110, 0.2);
  overflow: hidden;
}
.admin-brand-logo {
  width: 30px;
  height: 30px;
  display: block;
  object-fit: cover;
}
.admin-brand-name {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.3px;
  white-space: nowrap;
}
.admin-side-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-tertiary, #94a3b8);
  padding: 0 10px 10px;
  letter-spacing: 1px;
}
.admin-menu { display: flex; flex-direction: column; gap: 4px; }
.admin-menu-group {
  font-size: 11px;
  color: var(--text-tertiary, #94a3b8);
  padding: 14px 10px 4px;
  letter-spacing: 0.5px;
}
.admin-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary, #475569);
  font-size: 14px;
  cursor: pointer;
  text-align: left;
  transition: background 0.15s, color 0.15s;
}
.admin-menu-item:hover { background: var(--bg-hover, rgba(37, 99, 235, 0.06)); }
.admin-menu-item.active {
  background: var(--primary-soft, #eff4ff);
  color: var(--primary, #2563eb);
  font-weight: 600;
}
.admin-menu-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}
.admin-side-foot {
  margin-top: auto;
  padding: 14px 10px 0;
  border-top: 1px solid var(--border-light, #e8ecf0);
  font-size: 11px;
  color: var(--text-tertiary, #94a3b8);
}

/* ===== 主区（顶栏 + 内容） ===== */
.admin-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.admin-topbar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 64px;
  padding: 0 24px;
  background: var(--bg-primary, #ffffff);
  border-bottom: 1px solid var(--border-light, #e8ecf0);
}
.admin-global-search {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 280px;
  height: 38px;
  padding: 0 12px;
  background: var(--bg-secondary, #f1f5fb);
  border-radius: 8px;
  color: var(--text-tertiary, #94a3b8);
  flex-shrink: 0;
}
.admin-global-search input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  outline: none;
  font-size: 13px;
  color: var(--text-primary, #1f2937);
}
.admin-global-search input::placeholder { color: var(--text-tertiary, #94a3b8); }
.admin-topbar-right {
  display: flex;
  align-items: center;
  gap: 16px;
}
.admin-icon-btn {
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 8px;
  background: var(--bg-secondary, #f1f5fb);
  color: var(--text-secondary, #475569);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.admin-icon-btn:hover { background: var(--bg-hover, rgba(37, 99, 235, 0.08)); color: var(--primary, #2563eb); }
.admin-user-menu {
  display: flex;
  align-items: center;
  gap: 10px;
}
.admin-user-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--primary, #2563eb);
  color: #fff;
  display: grid;
  place-items: center;
  font-size: 14px;
  font-weight: 600;
}
.admin-user-name {
  font-size: 14px;
  color: var(--text-secondary, #475569);
}

/* ===== 内容区（唯一滚动区） ===== */
.admin-content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 24px 24px 48px;
}
.admin-crumb {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  margin-bottom: 18px;
  color: var(--text-tertiary, #94a3b8);
}
.admin-crumb-root { color: var(--text-secondary, #475569); }
.admin-crumb-current { color: var(--text-primary, #1f2937); font-weight: 500; }

/* ===== 窄屏适配 ===== */
@media (max-width: 900px) {
  .admin-sidebar {
    position: fixed;
    top: 0;
    bottom: 0;
    left: 0;
    z-index: 130;
    width: 240px;
    transform: translateX(-100%);
    transition: transform 0.25s ease;
    box-shadow: var(--shadow-xl, 0 20px 25px -5px rgba(0, 0, 0, 0.1));
  }
  .admin-sidebar.open { transform: translateX(0); }
  .admin-content { padding: 16px 14px 40px; }
  .admin-topbar { justify-content: flex-end; }
  .admin-global-search { display: none; }
  /* 无顶栏，悬浮汉堡按钮开抽屉 */
  .admin-burger-fab {
    position: fixed;
    top: 12px;
    left: 12px;
    z-index: 110;
    width: 40px;
    height: 40px;
    border: none;
    border-radius: 10px;
    background: var(--bg-primary, #ffffff);
    color: var(--text-secondary, #475569);
    font-size: 20px;
    box-shadow: var(--shadow-md, 0 4px 6px -1px rgba(0, 0, 0, 0.1));
    cursor: pointer;
  }
}
</style>