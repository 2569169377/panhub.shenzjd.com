<template>
  <div class="admin-shell">
    <!-- 遮罩（移动端抽屉打开时） -->
    <div v-if="menuOpen" class="admin-mask" @click="menuOpen = false" />

    <div class="admin-body">
      <!-- 侧栏（桌面常驻 / 移动端抽屉）：固定在左侧，不随内容滚动 -->
      <aside :class="['admin-sidebar', { open: menuOpen }]">
        <!-- 品牌（原顶栏迁入侧栏） -->
        <NuxtLink to="/" class="admin-brand" title="返回首页">
          <span class="admin-brand-badge">P</span>
          <span class="admin-brand-name">PanHub</span>
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
              <span class="admin-menu-icon">{{ item.icon }}</span>
              <span>{{ item.label }}</span>
            </button>
          </template>
        </nav>

        <div class="admin-side-foot">v2 · 2026-08-25</div>
      </aside>

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
 * 管理后台规范化布局（2026-08-25 v2 重构）
 * 结构：固定顶栏（品牌 + 顶部菜单 + 用户区）+ 左侧分组菜单 + 内容区。
 *
 * 与页面的协作（provide/inject 共享响应式 ref，键见 ~/utils/adminKeys）：
 * - activeKey：当前激活菜单（布局渲染高亮/面包屑，页面据此渲染面板）
 * - setActive：切换菜单
 */
interface AdminMenuItem {
  key: string;
  label: string;
  icon: string;
}
interface AdminMenuGroup {
  label?: string;
  items: AdminMenuItem[];
}

/** 菜单分组（新增功能往这里加；页面面板须与 key 对应渲染） */
const MENU_GROUPS: AdminMenuGroup[] = [
  {
    label: "概览",
    items: [{ key: "overview", label: "流量概览", icon: "📊" }],
  },
  {
    label: "频道",
    items: [{ key: "channels", label: "频道管理", icon: "📡" }],
  },
  {
    label: "防护",
    items: [
      { key: "search-log", label: "搜索记录", icon: "🔍" },
      { key: "blacklist", label: "IP 黑名单", icon: "🚫" },
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
  background: var(--bg-secondary, #f7f3ea);
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
  width: 216px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow-y: auto;
  padding: 16px 12px;
  background: var(--bg-primary, #fffdf8);
  border-right: 1px solid var(--border-light, #e5dfd0);
}
.admin-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  text-decoration: none;
  color: var(--text-primary, #1f2937);
  padding: 4px 10px 14px;
  border-bottom: 1px solid var(--border-light, #f0ead9);
  margin-bottom: 12px;
}
.admin-brand-badge {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: var(--primary, #0f766e);
  color: var(--text-on-primary, #fff);
  display: grid;
  place-items: center;
  font-weight: 800;
  font-size: 15px;
}
.admin-brand-name {
  font-size: 17px;
  font-weight: 800;
  letter-spacing: 0.3px;
}
.admin-side-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-tertiary, #9ca3af);
  padding: 0 10px 10px;
  letter-spacing: 1px;
}
.admin-menu { display: flex; flex-direction: column; gap: 2px; }
.admin-menu-group {
  font-size: 11px;
  color: var(--text-tertiary, #9ca3af);
  padding: 14px 10px 4px;
  letter-spacing: 0.5px;
}
.admin-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary, #4b5563);
  font-size: 14px;
  cursor: pointer;
  text-align: left;
  transition: background 0.15s, color 0.15s;
}
.admin-menu-item:hover { background: var(--bg-hover, rgba(15, 118, 110, 0.04)); }
.admin-menu-item.active {
  background: var(--primary, #0f766e);
  color: var(--text-on-primary, #fff);
  font-weight: 600;
}
.admin-menu-icon { width: 20px; text-align: center; }
.admin-side-foot {
  margin-top: auto;
  padding: 14px 10px 0;
  border-top: 1px solid var(--border-light, #eee);
  font-size: 11px;
  color: var(--text-tertiary, #9ca3af);
}

/* ===== 内容区（唯一滚动区） ===== */
.admin-content {
  flex: 1;
  min-width: 0;
  height: 100vh;
  overflow-y: auto;
  padding: 20px 24px 48px;
}
.admin-crumb {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  margin-bottom: 18px;
  color: var(--text-tertiary, #9ca3af);
}
.admin-crumb-root { color: var(--text-secondary, #4b5563); }
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
    background: var(--bg-primary, #fffdf8);
    color: var(--text-secondary, #4b5563);
    font-size: 20px;
    box-shadow: var(--shadow-md, 0 4px 6px -1px rgba(0, 0, 0, 0.1));
    cursor: pointer;
  }
}
</style>