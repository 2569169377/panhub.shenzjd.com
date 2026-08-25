<template>
  <!-- 纯净后台布局（2026-08-25 用户拍板：admin 页"上面都不要"）：
       无顶部导航 / 公告条 / 密码门 / 赞赏码浮窗，只看管理内容 -->
  <main class="main">
    <slot />
  </main>
</template>

<script setup lang="ts">
// 管理页专用布局：不加载 floating-qr、不提供 requestUnlock、无导航。
// 正常客户页面走 layouts/default.vue，两边完全解耦，admin 逻辑不影响搜索页面。
</script>
