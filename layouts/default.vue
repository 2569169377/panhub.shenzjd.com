<template>
  <!-- 正常客户页面布局（2026-08-25 从 app.vue 搬移）：导航/公告/密码门/浮窗 -->
  <!-- admin 页面走 layouts/admin.vue（纯净后台），与本站完全解耦 -->
  <header class="header">
    <nav class="nav">
      <NuxtLink to="/" class="brand">
        <span class="brand-icon">🔍</span>
        <span class="brand-text">PanHub</span>
      </NuxtLink>

      <!-- 移动端菜单按钮 -->
      <button class="btn-icon nav-menu-btn" type="button" @click="showNavMenu = !showNavMenu" aria-label="导航菜单" title="导航菜单">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="3" y1="6" x2="21" y2="6"></line>
          <line x1="3" y1="12" x2="21" y2="12"></line>
          <line x1="3" y1="18" x2="21" y2="18"></line>
        </svg>
      </button>

      <!-- 桌面端导航链接 -->
      <div class="nav-links">
        <a
          v-for="link in navLinks"
          :key="link.name"
          :href="link.isCurrent ? undefined : link.url"
          :class="['nav-link', { active: link.isCurrent }]"
          :target="link.isCurrent ? undefined : '_blank'"
          :rel="link.isCurrent ? undefined : 'noopener noreferrer'">
          {{ link.name }}
        </a>
      </div>

      <!-- 移动端下拉菜单 -->
      <ClientOnly>
        <Transition name="nav-menu">
          <div v-if="showNavMenu" class="nav-dropdown">
            <a
              v-for="link in navLinks"
              :key="link.name"
              :href="link.isCurrent ? undefined : link.url"
              :class="['nav-dropdown__link', { active: link.isCurrent }]"
              :target="link.isCurrent ? undefined : '_blank'"
              :rel="link.isCurrent ? undefined : 'noopener noreferrer'"
              @click="showNavMenu = false">
              {{ link.name }}
            </a>
          </div>
        </Transition>
      </ClientOnly>
    </nav>
  </header>

  <!-- 公告条（全站导航栏下方；关闭后不再显示，改公告内容时升级 key 版本号重新展示） -->
  <div v-if="showAnnouncement" class="announce-bar" role="status">
    <span class="announce-bar__text">
      📢 为节省服务器资源，默认搜索 <strong>90 条</strong>结果即自动暂停；
      如需更多结果，点击「继续」即可继续搜索
    </span>
    <button class="announce-bar__close" type="button" @click="dismissAnnouncement" aria-label="关闭公告" title="关闭">✕</button>
  </div>

  <!-- 主内容区 -->
  <main class="main">
    <slot />
  </main>

  <!-- 页脚（隐私政策链接，2026-08-26 从 app.vue 移入：仅客户页显示，admin 后台不显示） -->
  <footer class="site-footer">
    <NuxtLink to="/privacy" class="footer-link">隐私政策</NuxtLink>
    <span class="footer-sep">·</span>
    <span class="footer-copy">© {{ new Date().getFullYear() }} PanHub</span>
  </footer>

  <!-- 密码门（仅在用户发起搜索时弹出） -->
  <ClientOnly>
    <PasswordGate
      :show="showPasswordGate"
      :error="auth.error.value || ''"
      :submitting="unlockSubmitting"
      @unlock="onUnlock" />
  </ClientOnly>
</template>

<script setup lang="ts">
// 悬浮二维码 Web Component（公众号/赞赏码）：仅正常客户页面加载。
// admin 页面走 admin 布局，天然不加载本脚本（无 watch/isAdmin 判断，
// 布局隔离即隔离，2026-08-25 重构，修复 app.vue 全局 500）
useHead({
  script: [
    {
      src: "https://unpkg.com/@wu529778790/floating-qr@latest/dist/floating-qr.wc.js",
      body: true,
    },
  ],
});

const { loadSettings } = useSettings();
const auth = useAuth();
const showPasswordGate = ref(false);
const showNavMenu = ref(false);

// 导航链接
const navLinks = [
  { name: "首页", url: "https://shenzjd.com" },
  { name: "Alist", url: "https://alist.shenzjd.com" },
  { name: "网盘搜索", url: "https://panhub.shenzjd.com", isCurrent: true },
  { name: "视频解析", url: "https://parse.shenzjd.com" },
  { name: "热点聚合", url: "https://newshub.shenzjd.com" },
  { name: "个人导航", url: "https://navhub.shenzjd.com" },
  { name: "必应壁纸", url: "https://bing.shenzjd.com" },
];

const unlockSubmitting = ref(false);
const pendingOnUnlock = ref<(() => void) | null>(null);

function requestUnlock(onSuccess?: () => void) {
  pendingOnUnlock.value = onSuccess ?? null;
  showPasswordGate.value = true;
}

async function onUnlock(password: string) {
  unlockSubmitting.value = true;
  const ok = await auth.unlock(password);
  unlockSubmitting.value = false;
  if (ok) {
    showPasswordGate.value = false;
    const cb = pendingOnUnlock.value;
    pendingOnUnlock.value = null;
    if (cb) {
      nextTick(() => cb());
    }
  }
}

provide("requestUnlock", requestUnlock);

onMounted(() => {
  loadSettings();
  auth.fetchStatus();
  checkAnnouncement();
  document.addEventListener("click", onDocumentClick);
});

onBeforeUnmount(() => {
  document.removeEventListener("click", onDocumentClick);
});

function onDocumentClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (showNavMenu.value && !target.closest(".nav-menu-btn") && !target.closest(".nav-dropdown")) {
    showNavMenu.value = false;
  }
}

// 公告条（v2：搜索上限 50→90 自动暂停。改公告内容时升级 key 版本号，让已关闭用户重新看到）
const ANNOUNCEMENT_KEY = "panhub:announcement-dismissed:v2";
const showAnnouncement = ref(false);
function checkAnnouncement() {
  try {
    if (localStorage.getItem(ANNOUNCEMENT_KEY)) return;
  } catch {}
  showAnnouncement.value = true;
}
function dismissAnnouncement() {
  showAnnouncement.value = false;
  try {
    localStorage.setItem(ANNOUNCEMENT_KEY, "1");
  } catch {}
}
</script>

<style scoped>
/* 顶部导航 - 玻璃拟态 */
.header {
  background: var(--bg-glass);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-bottom: 1px solid var(--border-glass);
  position: sticky;
  top: 0;
  z-index: 100;
  box-shadow: var(--shadow-sm);
}

.nav {
  max-width: 1100px;
  margin: 0 auto;
  padding: 16px 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

/* 品牌标识 */
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  text-decoration: none;
  color: var(--text-primary);
  font-weight: 700;
  font-size: 20px;
  transition: transform var(--transition-fast);
}

.brand:hover {
  transform: scale(1.05);
}

.brand-icon {
  font-size: 24px;
  filter: drop-shadow(0 2px 4px rgba(15, 118, 110, 0.3));
}

.brand-text {
  background: linear-gradient(135deg, var(--primary), var(--secondary));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

/* 图标按钮 */
.btn-icon {
  width: 40px;
  height: 40px;
  border: none;
  background: var(--bg-btn);
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-primary);
  transition: background-color var(--transition-fast), color var(--transition-fast),
    transform var(--transition-fast), box-shadow var(--transition-fast);
  backdrop-filter: blur(10px);
  border: 1px solid var(--border-glass);
}

.btn-icon:hover {
  background: var(--bg-btn-hover);
  transform: translateY(-2px);
  box-shadow: var(--shadow-md);
}

.btn-icon:active {
  transform: translateY(0);
}

.btn-icon svg {
  stroke: currentColor;
}

/* 导航链接（桌面端） */
.nav-links {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  justify-content: center;
}

.nav-link {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  text-decoration: none;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  transition: color var(--transition-fast), background var(--transition-fast);
  white-space: nowrap;
}

.nav-link:hover {
  color: var(--primary);
  background: var(--bg-hover);
}

.nav-link.active {
  color: var(--primary);
  font-weight: 700;
  background: rgba(15, 118, 110, 0.08);
}

/* 移动端菜单按钮（桌面隐藏） */
.nav-menu-btn {
  display: none;
}

/* 移动端下拉菜单 */
.nav-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  background: var(--bg-glass-strong);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-bottom: 1px solid var(--border-glass);
  box-shadow: var(--shadow-lg);
  padding: 12px 16px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  z-index: 99;
}

.nav-dropdown__link {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-secondary);
  text-decoration: none;
  padding: 8px 14px;
  border-radius: var(--radius-sm);
  transition: color var(--transition-fast), background var(--transition-fast);
  width: calc(50% - 4px);
}

.nav-dropdown__link:hover {
  color: var(--primary);
  background: var(--bg-hover);
}

.nav-dropdown__link.active {
  color: var(--primary);
  font-weight: 700;
  background: rgba(15, 118, 110, 0.08);
}

/* 下拉菜单动画 */
.nav-menu-enter-active,
.nav-menu-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.nav-menu-enter-from,
.nav-menu-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

/* 公告条（全宽细条，导航栏下方） */
.announce-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding: 7px 16px;
  background: linear-gradient(90deg, rgba(15, 118, 110, 0.08) 0%, rgba(59, 130, 246, 0.08) 100%);
  border-bottom: 1px solid rgba(15, 118, 110, 0.12);
  font-size: 13px;
  color: var(--text-secondary, #4b5563);
  line-height: 1.5;
  animation: barSlideIn 0.3s ease;
}
.announce-bar__text {
  text-align: center;
}
.announce-bar__text strong {
  color: var(--primary, #0f766e);
}
.announce-bar__close {
  flex-shrink: 0;
  background: none;
  border: none;
  font-size: 14px;
  color: var(--text-tertiary, #9ca3af);
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}
.announce-bar__close:hover {
  color: var(--text-secondary, #4b5563);
}
@keyframes barSlideIn {
  from {
    transform: translateY(-4px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

/* 移动端优化 */
@media (max-width: 900px) {
  .nav {
    padding: 12px 16px;
  }

  .nav-links {
    display: none;
  }

  .nav-menu-btn {
    display: flex;
  }

  .btn-icon {
    width: 36px;
    height: 36px;
  }

  .brand {
    font-size: 18px;
  }
}

/* 高对比度模式支持 */
@media (prefers-contrast: high) {
  .btn-icon {
    border-width: 2px;
  }

  .brand-text {
    -webkit-text-fill-color: var(--text-primary);
    color: var(--text-primary);
  }
}

/* 页脚（隐私政策链接，2026-08-26 从 app.vue 移入：仅客户页布局显示，admin 后台不显示） */
.site-footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 18px 16px 28px;
  font-size: 13px;
  color: var(--text-tertiary, #9ca3af);
}
.footer-link {
  color: var(--text-secondary, #6b7280);
  text-decoration: none;
}
.footer-link:hover {
  color: var(--accent, #2563eb);
}
.footer-sep {
  opacity: 0.5;
}
</style>
