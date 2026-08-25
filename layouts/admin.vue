<template>
  <div class="admin-shell">
    <!-- 顶栏：品牌 + 顶部菜单 + 用户区 -->
    <header class="admin-topbar">
      <button type="button" class="admin-burger" aria-label="打开菜单" @click="menuOpen = true">☰</button>
      <NuxtLink to="/admin" class="admin-brand">
        <span class="admin-brand-badge">P</span>
        <span class="admin-brand-name">PanHub</span>
      </NuxtLink>

      <!-- 桌面顶部菜单（小屏隐藏，用抽屉） -->
      <nav v-if="!isMobile" class="admin-topnav">
        <button
          v-for="item in flatMenus"
          :key="item.key"
          type="button"
          :class="['admin-topnav-item', { active: item.key === activeKey }]"
          @click="setActive(item.key)">
          <span class="admin-menu-icon">{{ item.icon }}</span>
          <span>{{ item.label }}</span>
        </button>
      </nav>

      <div class="admin-top-actions">
        <span v-if="authStatus === 'ok'" class="admin-user-chip" title="微信关注公众号登录">
          <span class="admin-user-dot"></span>
          管理员
        </span>
        <NuxtLink to="/" class="admin-home-link">← 回首页</NuxtLink>
      </div>
    </header>

    <!-- 遮罩（移动端抽屉打开时） -->
    <div v-if="menuOpen" class="admin-mask" @click="menuOpen = false" />

    <div class="admin-body">
      <!-- 侧栏（桌面常驻 / 移动端抽屉） -->
      <aside :class="['admin-sidebar', { open: menuOpen }]">
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

      <!-- 内容区 -->
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
</template>

<script setup lang="ts">
import { ADMIN_NAV_KEY, ADMIN_AUTH_KEY } from "~/utils/adminKeys";

/**
 * 管理后台规范化布局（2026-08-25 v2 重构）
 * 结构：固定顶栏（品牌 + 顶部菜单 + 用户区）+ 左侧分组菜单 + 内容区。
 *
 * 与页面的协作（provide/inject 共享响应式 ref，键见 ~/utils/adminKeys）：
 * - activeKey：当前激活菜单（布局渲染高亮/面包屑，页面据此渲染面板）
 * - setActive：切换菜单
 * - authStatus：管理员状态（页面探测后写入，布局顶栏显示"管理员"徽标）
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
    label: "防护",
    items: [
      { key: "search-log", label: "搜索记录", icon: "🔍" },
      { key: "blacklist", label: "IP 黑名单", icon: "🚫" },
    ],
  },
];

const activeKey = ref<string>("search-log");
const menuOpen = ref(false);
const isMobile = ref(false);
const authStatus = ref<"checking" | "ok" | "no-login" | "no-admin">("checking");

/** 顶部菜单取全部项（扁平） */
const flatMenus = computed(() => MENU_GROUPS.flatMap((g) => g.items));
const currentLabel = computed(
  () => flatMenus.value.find((m) => m.key === activeKey.value)?.label || "管理后台",
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

// 提供给页面：切换菜单 + 上报鉴权状态
provide(ADMIN_NAV_KEY, { activeKey, setActive });
provide(ADMIN_AUTH_KEY, authStatus);
</script>

<style scoped>
/* ===== 外壳 ===== */
.admin-shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  color: var(--text-primary, #1f2937);
  background: var(--bg-secondary, #f7f3ea);
}

/* ===== 顶栏 ===== */
.admin-topbar {
  position: sticky;
  top: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  gap: 16px;
  height: 56px;
  padding: 0 20px;
  background: var(--bg-primary, #fffdf8);
  border-bottom: 1px solid var(--border-light, #e5dfd0);
}
.admin-burger {
  display: none;
  border: none;
  background: transparent;
  font-size: 20px;
  color: var(--text-secondary, #4b5563);
  padding: 4px 8px;
}
.admin-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  text-decoration: none;
  color: var(--text-primary, #1f2937);
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
.admin-topnav {
  display: flex;
  gap: 4px;
  margin-left: 12px;
}
.admin-topnav-item {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 12px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary, #4b5563);
  font-size: 14px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.admin-topnav-item:hover { background: var(--bg-hover, rgba(15, 118, 110, 0.04)); }
.admin-topnav-item.active {
  background: var(--bg-active, rgba(15, 118, 110, 0.08));
  color: var(--primary, #0f766e);
  font-weight: 600;
}
.admin-top-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 12px;
}
.admin-user-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 5px 12px;
  border-radius: 999px;
  background: var(--bg-active, rgba(15, 118, 110, 0.08));
  color: var(--primary, #0f766e);
  font-size: 13px;
  font-weight: 500;
}
.admin-user-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--success, #10b981);
}
.admin-home-link {
  color: var(--text-secondary, #4b5563);
  font-size: 13px;
  text-decoration: none;
}
.admin-home-link:hover { color: var(--primary, #0f766e); }

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
  min-height: 0;
}

/* ===== 侧栏 ===== */
.admin-sidebar {
  width: 216px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  padding: 16px 12px;
  background: var(--bg-primary, #fffdf8);
  border-right: 1px solid var(--border-light, #e5dfd0);
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

/* ===== 内容区 ===== */
.admin-content {
  flex: 1;
  min-width: 0;
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
  .admin-burger { display: block; }
  .admin-topnav { display: none; }
  .admin-sidebar {
    position: fixed;
    top: 56px;
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
}
</style>