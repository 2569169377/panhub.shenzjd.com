<template>
  <ClientOnly>
    <!-- 悬浮公众号引导卡片（仿 ParseShort 风格） -->
    <Transition name="wechat-card">
      <aside
        v-if="visible"
        class="wechat-guide"
        role="complementary"
        aria-label="公众号引导">
        <header class="wechat-guide__head">
          <span class="wechat-guide__title">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M8.69 2C4.9 2 1.8 4.69 1.8 8c0 1.93 1.05 3.64 2.7 4.79-.08.27-.32 1.04-.37 1.21 0 0-.01.06.03.09.04.04.09.02.09.02.18-.03 1.21-.74 1.42-.87.92.25 1.9.39 2.92.39.21 0 .41-.01.62-.02-.13-.39-.21-.81-.21-1.24 0-2.62 2.49-4.74 5.56-4.74.21 0 .41.01.62.03C14.43 4.4 11.83 2 8.69 2zm-2.4 3.4a.85.85 0 1 1 0 1.7.85.85 0 0 1 0-1.7zm4.8 0a.85.85 0 1 1 0 1.7.85.85 0 0 1 0-1.7zM14.6 8c-3.07 0-5.56 2.12-5.56 4.74 0 1.34.66 2.55 1.72 3.42-.05.18-.21.7-.25.81 0 0-.01.04.02.06.03.03.06.01.06.01.12-.02.81-.5.95-.58.62.17 1.28.26 1.96.26.21 0 .41-.01.62-.03-.13-.4-.21-.81-.21-1.24 0-.12.01-.24.02-.36-.21.04-.41.06-.62.06-2.59 0-4.7-1.62-4.7-3.62 0-.65.27-1.27.73-1.79-.65-.08-1.32-.08-1.93-.01.74-.69 1.74-1.13 2.84-1.13.21 0 .41.01.62.03-.13-.39-.21-.81-.21-1.24 0-.12.01-.24.02-.36.21.04.41.06.62.06.45 0 .9-.05 1.33-.13C11.4 6.83 9.66 6 7.85 6c-.24 0-.47.01-.7.04C5.39 4.59 4.05 4.59 2.8 5.79c.18.36.42.7.7.99C5.07 7.92 6.79 8.78 8.7 8.78c.21 0 .41-.01.62-.03C7.4 7.4 7.2 6.99 7.2 6.56c0-.65.27-1.27.73-1.79C9.62 5.89 11.16 6.83 12.45 8.04c-.85-.6-1.91-1-3.07-1-.36 0-.71.04-1.05.11C8.71 6.43 9.46 6 10.31 6c1.38 0 2.61.78 3.43 1.99C13.07 7.99 12.31 8 11.55 8h3.05z"/>
            </svg>
            公众号
          </span>
          <button
            class="wechat-guide__close"
            type="button"
            aria-label="关闭公众号引导"
            title="关闭"
            @click="dismiss">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
              <line x1="6" y1="6" x2="18" y2="18"></line>
              <line x1="6" y1="18" x2="18" y2="6"></line>
            </svg>
          </button>
        </header>

        <div class="wechat-guide__qr">
          <img
            :src="qrSrc"
            :alt="qrAlt"
            width="120"
            height="120"
            loading="lazy"
            decoding="async"
            data-kind="qr"
            @error="onImgError" />
        </div>

        <p class="wechat-guide__hint">关注获取最新更新</p>

        <!-- 赞赏码 -->
        <div class="wechat-guide__divider" aria-hidden="true"></div>
        <span class="wechat-guide__app-title">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
          </svg>
          赞赏支持
        </span>
        <div class="wechat-guide__qr wechat-guide__qr--app">
          <img
            :src="appreciationSrc"
            alt="赞赏码"
            width="120"
            height="120"
            loading="lazy"
            decoding="async"
            data-kind="app"
            @error="onImgError" />
        </div>
        <p class="wechat-guide__hint">扫码支持一下</p>
      </aside>
    </Transition>

    <!-- 关闭后的召回小红点 -->
    <Transition name="wechat-dot">
      <button
        v-if="dismissed && !visible"
        class="wechat-reopen"
        type="button"
        aria-label="重新显示公众号二维码"
        title="公众号"
        @click="reopen">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M8.69 2C4.9 2 1.8 4.69 1.8 8c0 1.93 1.05 3.64 2.7 4.79-.08.27-.32 1.04-.37 1.21 0 0-.01.06.03.09.04.04.09.02.09.02.18-.03 1.21-.74 1.42-.87.92.25 1.9.39 2.92.39 3.07 0 5.56-2.12 5.56-4.74C14.25 4.69 11.45 2 8.69 2z"/>
        </svg>
      </button>
    </Transition>
  </ClientOnly>
</template>

<script setup lang="ts">
import { ref } from "vue";

interface Props {
  /** 公众号二维码图片地址 */
  qrSrc?: string;
  /** 公众号二维码 alt 文本 */
  qrAlt?: string;
  /** 赞赏码图片地址 */
  appreciationSrc?: string;
  /** 赞赏码 alt 文本 */
  appreciationAlt?: string;
}

const props = withDefaults(defineProps<Props>(), {
  qrSrc: "https://cdn.jsdmirror.com/gh/wu529778790/img.shenzjd.com@master/wp/1782738963299-5wrchz.jpg",
  qrAlt: "公众号二维码",
  appreciationSrc: "https://cdn.jsdmirror.com/gh/wu529778790/img.shenzjd.com@master/blog/imgx-20260815-100157-net7.png",
  appreciationAlt: "赞赏码",
});

// 图片加载失败时自动尝试 jpg -> png 回退（各图独立，最多一次）
const fallbackSrc = ref<Record<string, string | null>>({ qr: null, app: null });

const visible = ref(true);
const dismissed = ref(false);

function onImgError(e: Event) {
  const img = e.target as HTMLImageElement;
  const kind = (img.dataset.kind || "qr") as "qr" | "app";
  const baseSrc = kind === "qr" ? props.qrSrc : props.appreciationSrc;
  if (!fallbackSrc.value[kind] && !img.dataset.retried) {
    img.dataset.retried = "1";
    fallbackSrc.value[kind] = baseSrc.replace(/\.jpg$/i, ".png");
    img.src = fallbackSrc.value[kind]!;
  }
}

function dismiss() {
  // 仅当前渲染消失，不做持久化：刷新后卡片重新出现
  visible.value = false;
  dismissed.value = true;
}

function reopen() {
  visible.value = true;
  dismissed.value = false;
}
</script>
<style scoped>
.wechat-guide {
  position: fixed;
  top: 50%;
  right: 20px;
  transform: translateY(-50%);
  z-index: 60;
  width: 132px;
  padding: 14px 12px 12px;
  background: var(--bg-glass-strong);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid var(--border-glass);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-xl);
  text-align: center;
  color: var(--text-primary);
  font-family: "Manrope", "Noto Sans SC", "PingFang SC", sans-serif;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.wechat-guide__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
}

.wechat-guide__title {
  flex: 1;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  font-weight: 700;
  color: var(--primary);
  letter-spacing: 0.5px;
}

.wechat-guide__title svg {
  color: var(--primary);
}

.wechat-guide__close {
  width: 18px;
  height: 18px;
  border: none;
  background: transparent;
  border-radius: 50%;
  color: var(--text-tertiary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
  padding: 0;
  flex-shrink: 0;
}

.wechat-guide__close:hover {
  background: var(--bg-hover);
  color: var(--text-secondary);
}

.wechat-guide__qr {
  width: 108px;
  height: 108px;
  margin: 0 auto;
  background: #fff;
  border-radius: var(--radius-md);
  padding: 4px;
  box-shadow: 0 0 0 1px var(--border-light);
  overflow: hidden;
}

.wechat-guide__qr img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.wechat-guide__hint {
  margin: 0;
  font-size: 11px;
  color: var(--text-tertiary);
  letter-spacing: 0.3px;
  line-height: 1.4;
}

/* 分隔线 */
.wechat-guide__divider {
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--border-medium), transparent);
  opacity: 0.6;
  margin: 2px 0;
}

/* 赞赏区块标题 */
.wechat-guide__app-title {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 700;
  color: var(--secondary);
  letter-spacing: 0.5px;
}

.wechat-guide__app-title svg {
  color: var(--secondary);
}

/* 赞赏码（略小于公众号码，主次分明） */
.wechat-guide__qr--app {
  width: 92px;
  height: 92px;
}

/* 召回小红点 */
.wechat-reopen {
  position: fixed;
  top: 50%;
  right: 16px;
  transform: translateY(-50%);
  z-index: 60;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: 1px solid var(--border-glass);
  background: var(--bg-glass-strong);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  color: var(--primary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: var(--shadow-lg);
  transition: background var(--transition-fast), color var(--transition-fast), transform var(--transition-fast);
  padding: 0;
}

.wechat-reopen:hover {
  background: var(--bg-btn-hover);
  color: var(--primary-dark);
  transform: translateY(-50%) scale(1.05);
}

/* 出现/收起动画 */
.wechat-card-enter-active,
.wechat-card-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}

.wechat-card-enter-from,
.wechat-card-leave-to {
  opacity: 0;
  transform: translateY(-50%) translateX(20px);
}

.wechat-dot-enter-active,
.wechat-dot-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.wechat-dot-enter-from,
.wechat-dot-leave-to {
  opacity: 0;
  transform: translateY(-50%) scale(0.6);
}

/* 移动端：右下角缩小版，避免遮挡内容 */
@media (max-width: 900px) {
  .wechat-guide {
    top: auto;
    bottom: 16px;
    right: 12px;
    transform: none;
    width: 116px;
    padding: 10px 10px 8px;
    box-shadow: var(--shadow-lg);
  }

  .wechat-card-enter-from,
  .wechat-card-leave-to {
    transform: translateY(20px);
  }

  .wechat-reopen {
    top: auto;
    bottom: 16px;
    right: 12px;
    transform: none;
  }

  .wechat-reopen:hover {
    transform: scale(1.05);
  }

  .wechat-guide__qr {
    width: 92px;
    height: 92px;
  }

  .wechat-guide__qr--app {
    width: 80px;
    height: 80px;
  }
}

/* 减少动画 */
@media (prefers-reduced-motion: reduce) {
  .wechat-card-enter-active,
  .wechat-card-leave-active,
  .wechat-dot-enter-active,
  .wechat-dot-leave-active {
    transition: none;
  }
}

/* 高对比度 */
@media (prefers-contrast: high) {
  .wechat-guide,
  .wechat-reopen {
    border-width: 2px;
  }
}
</style>