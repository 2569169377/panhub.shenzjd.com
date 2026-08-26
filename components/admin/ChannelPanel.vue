<template>
  <section class="admin-card">
    <div class="admin-card-head">
      <div>
        <h2>频道管理</h2>
        <p class="admin-card-desc">
          完整频道清单（含优先级频道）· 共 {{ total }} 个频道，版本 v{{ version || "-" }}
        </p>
      </div>
      <div class="admin-head-actions">
        <button type="button" class="btn btn-neutral" :disabled="loading || reloading" @click="load">
          {{ loading ? "加载中…" : "刷新" }}
        </button>
        <button type="button" class="btn btn-primary" :disabled="loading || reloading" @click="askReload">
          {{ reloading ? "重载中…" : "重新加载" }}
        </button>
      </div>
    </div>

    <p v-if="error" class="admin-notice admin-notice-error">{{ error }}</p>
    <p v-else-if="reloadMsg" class="admin-notice admin-notice-ok">{{ reloadMsg }}</p>

    <div v-if="loading" class="admin-state">加载中…</div>
    <template v-else>
      <div class="channel-block">
        <h3 class="channel-block-title">
          优先级频道
          <span class="channel-count">({{ priorityChannels.length }})</span>
        </h3>
        <div v-if="priorityChannels.length" class="channel-tags">
          <span v-for="c in priorityChannels" :key="c" class="channel-tag channel-tag-pri">{{ c }}</span>
        </div>
        <div v-else class="admin-state admin-state-sm">无</div>
      </div>

      <div class="channel-block">
        <h3 class="channel-block-title">
          默认频道
          <span class="channel-count">({{ defaultChannels.length }})</span>
        </h3>
        <div v-if="defaultChannels.length" class="channel-tags">
          <span v-for="c in defaultChannels" :key="c" class="channel-tag">{{ c }}</span>
        </div>
        <div v-else class="admin-state admin-state-sm">无</div>
      </div>
    </template>

    <AdminModal ref="modal" :title="'重新加载频道配置'" tone="primary" confirm-text="确认加载" />
  </section>
</template>

<script setup lang="ts">
/**
 * 频道管理面板（2026-08-26）
 * 展示完整频道清单（默认 + 优先级），支持"重新加载"（热拉最新配置，无需重启）。
 */
import { useAdminApi, type ChannelAdminData } from "~/composables/useAdminApi";
import AdminModal from "~/components/admin/AdminModal.vue";

const { loadChannels, reloadChannels } = useAdminApi();
const { showToast } = useToast();
const modalRef = ref<InstanceType<typeof AdminModal>>();

const loading = ref(false);
const reloading = ref(false);
const error = ref("");
const reloadMsg = ref("");
const data = ref<ChannelAdminData | null>(null);

const version = computed(() => data.value?.version ?? 0);
const priorityChannels = computed(() => data.value?.priorityChannels ?? []);
const defaultChannels = computed(() => data.value?.defaultChannels ?? []);
const total = computed(() => priorityChannels.value.length + defaultChannels.value.length);

async function load() {
  loading.value = true;
  error.value = "";
  reloadMsg.value = "";
  try {
    data.value = await loadChannels();
  } catch (e: any) {
    error.value = e?.message || "请求异常";
  } finally {
    loading.value = false;
  }
}

function askReload() {
  modalRef.value?.open({
    title: "重新加载频道配置",
    message: `将强制重新拉取最新频道清单（版本 ${version.value || "-"} → 最新）。\n期间若配置源不可用，将保持当前配置继续服务。`,
    onConfirm: async () => {
      await doReload();
    },
  });
}

async function doReload() {
  if (reloading.value) return;
  reloading.value = true;
  error.value = "";
  reloadMsg.value = "";
  try {
    const r = await reloadChannels();
    reloadMsg.value = `已重载：版本 ${r.version ?? "-"}，默认 ${r.defaultCount} + 优先 ${r.priorityCount} 个频道`;
    showToast("频道配置已重载", "success");
    await load(); // 刷新列表展示
  } catch (e: any) {
    showToast(e?.message || "重载失败", "error");
    throw e; // 让 modal 保持打开显示错误
  } finally {
    reloading.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.admin-head-actions { display: flex; gap: 8px; align-items: center; }
.channel-block { margin-top: 18px; }
.channel-block-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary, #1f2937);
  margin-bottom: 10px;
}
.channel-count { color: var(--text-tertiary, #9ca3af); font-weight: 400; font-size: 13px; }
.channel-tags { display: flex; flex-wrap: wrap; gap: 8px; }
.channel-tag {
  display: inline-block;
  padding: 5px 12px;
  border-radius: 999px;
  background: var(--bg-hover, rgba(15, 118, 110, 0.06));
  border: 1px solid var(--border-light, #e5dfd0);
  color: var(--text-primary, #1f2937);
  font-size: 13px;
  word-break: break-all;
}
.channel-tag-pri {
  background: rgba(15, 118, 110, 0.14);
  border-color: rgba(15, 118, 110, 0.3);
  color: var(--primary, #0f766e);
  font-weight: 500;
}
.admin-state-sm { padding: 8px 0; font-size: 13px; }
</style>