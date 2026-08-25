<template>
  <Teleport to="body">
    <div v-if="visible" class="admin-toast" :class="type" role="status" aria-live="polite">
      {{ message }}
    </div>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * 管理后台轻提示（2026-08-25 admin 规范化重构）
 * 简单自包含实现（不依赖全站 useToast 的 app.vue 挂载点，管理布局独立）。
 * 用法：
 *   const toast = ref<InstanceType<typeof AdminToast>>();
 *   toast.value?.show("已拉黑", "success");
 */
const visible = ref(false);
const message = ref("");
const type = ref<"info" | "success" | "error">("info");
let timer: ReturnType<typeof setTimeout> | null = null;

function show(msg: string, t: "info" | "success" | "error" = "info", duration = 2400) {
  message.value = msg;
  type.value = t;
  visible.value = true;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    visible.value = false;
  }, duration);
}

defineExpose({ show });
</script>

<style scoped>
.admin-toast-mask {
  position: fixed;
  top: 64px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2100;
  pointer-events: none;
  padding: 10px 18px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 500;
  box-shadow: var(--shadow-lg, 0 10px 15px -3px rgba(0, 0, 0, 0.1));
  border: 1px solid var(--border-light, #e5dfd0);
  animation: toastIn 0.2s ease;
  max-width: min(480px, calc(100vw - 32px));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.admin-toast-mask.info { background: var(--bg-secondary, #fff); color: var(--text-primary, #1f2937); }
.admin-toast-mask.success { background: var(--success, #10b981); color: var(--text-on-success, #fff); border-color: transparent; }
.admin-toast-mask.error { background: var(--error, #ef4444); color: var(--text-on-danger, #fff); border-color: transparent; }
</style>