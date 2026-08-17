<template>
  <!-- 悬浮二维码宿主：由 @wu529778790/floating-qr 原生渲染到 body -->
</template>

<script setup lang="ts">
import "@wu529778790/floating-qr/style.css";

let instance: any = null;

onMounted(async () => {
  try {
    const { default: FloatingQR } = await import("@wu529778790/floating-qr");
    instance = new FloatingQR({
      wechat: {
        src: "https://cdn.jsdmirror.com/gh/wu529778790/img.shenzjd.com@master/wp/1782738963299-5wrchz.jpg",
        title: "公众号",
        desc: "关注获取最新更新",
      },
      donate: {
        src: "https://cdn.jsdmirror.com/gh/wu529778790/img.shenzjd.com@master/blog/imgx-20260815-100157-net7.png",
        title: "赞赏码",
        desc: "扫码支持一下",
      },
      // 与旧 WechatGuideCard 一致：桌面端右中部悬浮；移动端按包默认隐藏（<768px）
      position: "right-center",
      theme: {
        bg: "var(--bg-glass-strong)",
        accent: "var(--primary)",
        radius: "var(--radius-lg)",
        border: "var(--border-glass)",
      },
    });
  } catch (e) {
    console.warn("[FloatingQrHost] 悬浮二维码初始化失败:", e);
  }
});

onBeforeUnmount(() => {
  try {
    instance?.destroy();
  } catch {}
  instance = null;
});
</script>
