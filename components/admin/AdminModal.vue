<template>
  <Teleport to="body">
    <div v-if="visible" class="admin-modal-mask" @click.self="onCancel">
      <div class="admin-modal" role="dialog" aria-modal="true" :aria-label="title">
        <div class="admin-modal-head">
          <span class="admin-modal-title" :class="`tone-${tone}`">{{ title }}</span>
          <button type="button" class="admin-modal-close" aria-label="关闭" @click="onCancel">×</button>
        </div>
        <div class="admin-modal-body">
          <slot>
            <p class="admin-modal-msg">{{ message }}</p>
          </slot>
        </div>
        <div class="admin-modal-foot">
          <button type="button" class="btn btn-neutral" :disabled="busy" @click="onCancel">{{ cancelText }}</button>
          <button
            type="button"
            class="btn"
            :class="tone === 'danger' ? 'btn-danger-solid' : 'btn-primary'"
            :disabled="busy"
            @click="onConfirm">
            {{ busy ? loadingText : confirmText }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * 管理后台确认弹窗（2026-08-25 admin 规范化重构）
 * 替代 window.confirm/alert，样式走全站设计令牌，随 .dark 深色模式。
 *
 * 用法（父组件通过 ref 调用）：
 *   const modal = ref<InstanceType<typeof AdminModal>>();
 *   // 打开：设置本次操作的确认回调
 *   modal.value?.open({ onConfirm: async () => { await blockIp("1.2.3.4"); } });
 *   // 打开后用户点"确认" → 执行 onConfirm；执行成功自动关闭；失败保持打开并显示 error
 */
const props = withDefaults(
  defineProps<{
    title?: string;
    message?: string;
    confirmText?: string;
    cancelText?: string;
    tone?: "primary" | "danger";
  }>(),
  {
    title: "确认操作",
    message: "",
    confirmText: "确认",
    cancelText: "取消",
    tone: "primary",
  },
);

const visible = ref(false);
const busy = ref(false);
const errorMsg = ref("");
let onConfirmCb: (() => void | Promise<void>) | null = null;

function open(opts?: { title?: string; message?: string; onConfirm?: () => void | Promise<void> }) {
  if (opts?.title) props.title = opts.title;
  if (opts?.message) props.message = opts.message;
  onConfirmCb = opts?.onConfirm ?? null;
  busy.value = false;
  errorMsg.value = "";
  visible.value = true;
}

function close() {
  visible.value = false;
  onConfirmCb = null;
}

async function onConfirm() {
  busy.value = true;
  errorMsg.value = "";
  try {
    await onConfirmCb?.();
    close();
  } catch (e: any) {
    errorMsg.value = e?.message || "操作失败";
  } finally {
    busy.value = false;
  }
}

function onCancel() {
  if (busy.value) return;
  close();
}

defineExpose({ open, close });
</script>

<style scoped>
.admin-modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
  animation: modalFade 0.15s ease;
}
.admin-modal {
  width: min(440px, calc(100vw - 32px));
  background: var(--bg-secondary, #fff);
  border: 1px solid var(--border-light, #e5dfd0);
  border-radius: var(--radius-lg, 16px);
  box-shadow: var(--shadow-xl, 0 20px 25px -5px rgba(0, 0, 0, 0.1));
  animation: modalUp 0.2s ease;
}
.admin-modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px 8px;
}
.admin-modal-title {
  font-size: 16px;
  font-weight: 700;
}
.admin-modal-title.tone-danger { color: var(--error, #ef4444); }
.admin-modal-close {
  border: none;
  background: transparent;
  font-size: 22px;
  line-height: 1;
  color: var(--text-tertiary, #9ca3af);
  cursor: pointer;
  padding: 4px 8px;
}
.admin-modal-close:hover { color: var(--text-primary, #1f2937); }
.admin-modal-body { padding: 8px 20px 20px; }
.admin-modal-msg { margin: 0; font-size: 14px; line-height: 1.7; color: var(--text-secondary, #4b5563); word-break: break-all; }
.admin-modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  align-items: center;
  padding: 0 20px 20px;
}
.admin-modal-error {
  margin-right: auto;
  font-size: 12.5px;
  color: var(--error, #ef4444);
}
@keyframes modalUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
</style>