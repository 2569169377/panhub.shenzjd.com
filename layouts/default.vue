<template>
  <!-- 正常客户页面布局（2026-08-25 从 app.vue 搬移）：导航/公告/浮窗 -->
  <!-- admin 页面走 layouts/admin.vue（纯净后台），与本站完全解耦 -->
  <!-- 顶部导航：接入 site-navbar Web Component（头像登录依赖 wx-auth-sdk，脚本见下方 useHead） -->
  <ClientOnly>
    <site-navbar></site-navbar>
  </ClientOnly>

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
</template>

<script setup lang="ts">
// 悬浮二维码 Web Component（公众号/赞赏码）：仅正常客户页面加载。
// admin 页面走 admin 布局，天然不加载本脚本（无 watch/isAdmin 判断，
// 布局隔离即隔离，2026-08-25 重构，修复 app.vue 全局 500）
// 顶部导航 site-navbar Web Component + 头像登录依赖 wx-auth-sdk。
// 顺序：先 wx-auth-sdk（silent 静默校验登录态、required:false 可选认证），再 site-navbar。
useHead({
  script: [
    {
      src: "https://unpkg.com/wx-auth-sdk/dist/wx-auth.umd.js",
      body: true,
    },
    {
      innerHTML: `WxAuth.init({ silent: true, required: false })`,
      body: true,
    },
    {
      src: "https://unpkg.com/@wu529778790/site-navbar@latest/dist/site-navbar.wc.js",
      body: true,
    },
    {
      src: "https://unpkg.com/@wu529778790/floating-qr@latest/dist/floating-qr.wc.js",
      body: true,
    },
  ],
});

const { loadSettings } = useSettings();

onMounted(() => {
  loadSettings();
  checkAnnouncement();
});

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
/* 顶部导航已接入 site-navbar Web Component，样式由组件自带，此处不再维护 */

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
