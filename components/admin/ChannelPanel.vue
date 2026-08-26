<template>
  <section class="admin-card">
    <div class="admin-card-head">
      <div>
        <h2>频道管理</h2>
        <p class="admin-card-desc">
          全部频道 {{ allCount }} 个 · 优先 {{ priorityChannels.length }} + 默认 {{ defaultChannels.length }} ·
          版本 v{{ version || "-" }}
        </p>
      </div>
      <div class="admin-head-actions">
        <button type="button" class="btn btn-neutral" :disabled="loading || saving" @click="load">
          {{ loading ? "加载中…" : "刷新" }}
        </button>
        <button type="button" class="btn btn-neutral" :disabled="loading || saving" @click="askReload">
          {{ reloading ? "重载中…" : "重新加载" }}
        </button>
        <button type="button" class="btn btn-primary" :disabled="saving || !dirty" @click="askSave">
          {{ saving ? "保存中…" : "保存全部" }}
        </button>
      </div>
    </div>

    <p v-if="error" class="admin-notice admin-notice-error">{{ error }}</p>
    <p v-else-if="reloadMsg" class="admin-notice admin-notice-ok">{{ reloadMsg }}</p>

    <!-- 新增频道 -->
    <div class="channel-add">
      <input
        v-model="newName"
        type="text"
        class="channel-input"
        placeholder="输入频道名（如：xxx_tg）"
        :disabled="saving"
        @keyup.enter="addChannel"
      />
      <button type="button" class="btn btn-neutral" :disabled="saving || !newName.trim()" @click="addChannel">
        添加到默认
      </button>
    </div>

    <div v-if="loading" class="admin-state">加载中…</div>
    <template v-else>
      <p v-if="dirty" class="admin-notice admin-notice-warn">
        有未保存的修改，点击「保存全部」生效
      </p>

      <!-- 优先级频道（固定下发/不下发给 fork 站） -->
      <div class="channel-block">
        <h3 class="channel-block-title">
          优先级频道
          <span class="channel-count">({{ priorityChannels.length }})</span>
          <span class="channel-block-hint">固定使用，不下发给第三方</span>
        </h3>
        <div v-if="priorityChannels.length" class="channel-tags">
          <div v-for="c in priorityChannels" :key="c" class="channel-tag channel-tag-pri">
            <span class="channel-tag-name" :title="c">{{ c }}</span>
            <span class="channel-tag-actions">
              <button type="button" class="channel-tag-btn" title="取消优先（移到默认）" @click="unprioritize(c)">⬇</button>
              <button type="button" class="channel-tag-btn channel-tag-btn-danger" title="删除" @click="askRemove(c)">✕</button>
            </span>
          </div>
        </div>
        <div v-else class="admin-state admin-state-sm">无优先级频道</div>
      </div>

      <!-- 默认频道（全部下发） -->
      <div class="channel-block">
        <h3 class="channel-block-title">
          默认频道
          <span class="channel-count">({{ defaultChannels.length }})</span>
          <span class="channel-tag-hint">随 /api/channels 下发</span>
        </h3>
        <div v-if="defaultChannels.length" class="channel-tags">
          <div v-for="c in defaultChannels" :key="c" class="channel-tag">
            <span class="channel-tag-name" :title="c">{{ c }}</span>
            <span class="channel-tag-actions">
              <button type="button" class="channel-tag-btn" title="设为优先（固定）" @click="prioritize(c)">⬆</button>
              <button type="button" class="channel-tag-btn channel-tag-btn-danger" title="删除" @click="removeChannel(c)">✕</button>
            </span>
          </div>
        </div>
        <div v-else class="admin-state admin-state-sm">无默认频道</div>
      </div>
    </template>

    <AdminModal ref="modal" :title="'确认操作'" tone="primary" confirm-text="确认" />
  </section>
</template>

<script setup lang="ts">
/**
 * 频道管理面板（2026-08-26 CRUD 升级）
 *
 * 全部频道（priority + default）列举，支持：
 * - 新增（添加到默认）
 * - 删除（两个区均可）
 * - 设/取消优先（在两组间移动）
 * 本地编辑 → 批量「保存全部」（PUT 全量，服务端去重/互斥/空保护）。
 * 「重新加载」= 放弃本地修改、从远端重拉最新配置（如脚本 sync 后）。
 */
import { useAdminApi, type ChannelAdminData } from "~/composables/useAdminApi";
import AdminModal from "~/components/admin/AdminModal.vue";

const { loadChannels, saveChannels, reloadChannels } = useAdminApi();
const { showToast } = useToast();
const modalRef = ref<InstanceType<typeof AdminModal>>();

const loading = ref(false);
const saving = ref(false);
const reloading = ref(false);
const error = ref("");
const reloadMsg = ref("");
const dirty = ref(false);
const newName = ref("");

const base = ref<ChannelAdminData | null>(null);
const priorityChannels = ref<string[]>([]);
const defaultChannels = ref<string[]>([]);

const version = computed(() => base.value?.version ?? 0);
const allCount = computed(() => priorityChannels.value.length + defaultChannels.value.length);

/** 加载服务器最新配置 */
async function load() {
  loading.value = true;
  error.value = "";
  reloadMsg.value = "";
  try {
    const data = await loadChannels();
    base.value = data;
    priorityChannels.value = [...data.priorityChannels];
    defaultChannels.value = [...data.defaultChannels];
    dirty.value = false;
  } catch (e: any) {
    error.value = e?.message || "请求异常";
  } finally {
    loading.value = false;
  }
}

/** 新增（默认区） */
function addChannel() {
  const name = newName.value.trim();
  if (!name) return;
  if (priorityChannels.value.includes(name) || defaultChannels.value.includes(name)) {
    showToast("该频道已存在", "error");
    return;
  }
  defaultChannels.value.push(name);
  newName.value = "";
  dirty.value = true;
}

/** 删除频道（确认弹窗） */
function removeChannel(name: string) {
  modalRef.value?.open({
    title: "删除频道",
    message: `确定删除频道「${name}」吗？保存后对所有使用该频道列表的请求生效。`,
    tone: "danger",
    confirmText: "删除",
    onConfirm: async () => {
      defaultChannels.value = defaultChannels.value.filter((c) => c !== name);
      priorityChannels.value = priorityChannels.value.filter((c) => c !== name);
      dirty.value = true;
    },
  });
}

/** 升为优先（从默认移除，加入优先） */
function prioritize(name: string) {
  defaultChannels.value = defaultChannels.value.filter((c) => c !== name);
  if (!priorityChannels.value.includes(name)) priorityChannels.value.push(name);
  dirty.value = true;
}

/** 取消优先（加入默认） */
function unprioritize(name: string) {
  priorityChannels.value = priorityChannels.value.filter((c) => c !== name);
  if (!defaultChannels.value.includes(name)) defaultChannels.value.push(name);
  dirty.value = true;
}

/** 保存全部（确认弹窗） */
function askSave() {
  modalRef.value?.open({
    title: "保存频道配置",
    message: `将保存为 v${version.value + 1}：优先级 ${priorityChannels.value.length} 个、默认 ${defaultChannels.value.length} 个。\n保存后立即对所有请求生效。`,
    confirmText: "保存",
    onConfirm: async () => {
      await doSave();
    },
  });
}

async function doSave() {
  if (saving.value) return;
  saving.value = true;
  error.value = "";
  reloadMsg.value = "";
  try {
    const r = await saveChannels({
      priorityChannels: priorityChannels.value,
      defaultChannels: defaultChannels.value,
    });
    dirty.value = false;
    showToast(`已保存 v${r.version}`, "success");
    await load(); // 刷新列表（服务端做了互斥/去重，回读最新）
  } catch (e: any) {
    showToast(e?.message || "保存失败", "error");
    throw e; // 让 modal 保持打开显示错误
  } finally {
    saving.value = false;
  }
}

/** 重新加载（放弃本地未保存修改，从远端重拉） */
function askReload() {
  modalRef.value?.open({
    title: "重新加载频道配置",
    message: dirty.value
      ? "当前有未保存的修改，重新加载将丢弃这些修改，从远端拉取最新频道。\n确定继续吗？"
      : "将重新从远端拉取最新频道清单。\n确定继续吗？",
    confirmText: "重新加载",
    onConfirm: async () => {
      if (reloading.value) return;
      reloading.value = true;
      try {
        const r = await reloadChannels();
        await load();
        reloadMsg.value = `已重载：版本 ${r.version ?? "-"}，默认 ${r.defaultCount} + 优先 ${r.priorityCount} 个频道`;
        showToast("频道配置已重载", "success");
      } catch (e: any) {
        showToast(e?.message || "重载失败", "error");
        throw e;
      } finally {
        reloading.value = false;
      }
    },
  });
}

onMounted(load);
</script>

<style scoped>
.admin-head-actions { display: flex; gap: 8px; align-items: center; }
.channel-add {
  display: flex;
  gap: 10px;
  margin: 16px 0 4px;
  max-width: 520px;
}
.channel-input {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--border-light, #e5dfd0);
  border-radius: 8px;
  background: var(--bg-primary, #fff);
  color: var(--text-primary, #1f2937);
  font-size: 14px;
}
.channel-input:focus { outline: none; border-color: var(--primary, #0f766e); }
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
.channel-tag-hint { color: var(--text-tertiary, #9ca3af); font-weight: 400; font-size: 12px; }
.channel-tags { display: flex; flex-wrap: wrap; gap: 8px; }
.channel-tag {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px 6px 12px;
  border-radius: 999px;
  background: var(--bg-hover, rgba(15, 118, 110, 0.06));
  border: 1px solid var(--border-light, #e5dfd0);
  color: var(--text-primary, #1f2937);
  font-size: 13px;
}
.channel-tag-pri {
  background: rgba(15, 118, 110, 0.14);
  border-color: rgba(15, 118, 110, 0.3);
  color: var(--primary, #0f766e);
  font-weight: 500;
}
.channel-tag-name { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.channel-tag-actions { display: inline-flex; gap: 2px; }
.channel-tag-btn {
  border: none;
  background: transparent;
  color: var(--text-tertiary, #9ca3af);
  cursor: pointer;
  font-size: 13px;
  padding: 2px 4px;
  border-radius: 6px;
  line-height: 1;
}
.channel-tag-btn:hover { background: rgba(0, 0, 0, 0.06); color: var(--text-primary, #1f2937); }
.channel-tag-btn-danger:hover { background: rgba(239, 68, 68, 0.12); color: var(--error, #ef4444); }
.admin-state-sm { padding: 8px 0; font-size: 13px; }
.admin-notice-warn {
  background: rgba(245, 158, 11, 0.1);
  border: 1px solid rgba(245, 158, 11, 0.35);
  color: #b45309;
}
</style>