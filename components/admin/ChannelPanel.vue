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
        placeholder="输入频道名字后回车添加（默认频道）"
        :disabled="saving"
        @keyup.enter="addChannel"
      />
      <button type="button" class="btn btn-neutral" :disabled="saving || !newName.trim()" @click="addChannel">
        + 添加频道
      </button>
    </div>

    <div v-if="loading" class="admin-state">加载中…</div>
    <template v-else>
      <p v-if="dirty" class="admin-notice admin-notice-warn">
        有未保存的修改，点击「保存全部」生效
      </p>

      <table v-if="rows.length" class="channel-table">
        <thead>
          <tr>
            <th class="col-pri">优先级</th>
            <th class="col-name">频道名字</th>
            <th class="col-ops">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.name">
            <!-- 优先级 -->
            <td class="col-pri">
              <span :class="['channel-pri-badge', { 'is-pri': row.priority }]">
                {{ row.priority ? "优先" : "默认" }}
              </span>
            </td>
            <!-- 频道名字（行内编辑） -->
            <td class="col-name">
              <template v-if="editingName === row.name">
                <input
                  v-model="editValue"
                  type="text"
                  class="row-input"
                  :class="{ 'row-input-invalid': editError }"
                  :placeholder="row.name"
                  @keyup.enter="commitEdit(row)"
                  @keyup.esc="cancelEdit"
                />
                <button type="button" class="btn btn-primary btn-sm" @click="commitEdit(row)" :disabled="!editValue.trim()">✓</button>
                <button type="button" class="btn btn-neutral btn-sm" @click="cancelEdit">✕</button>
              </template>
              <span v-else class="channel-name" :title="row.name">{{ row.name }}</span>
            </td>
            <!-- 操作 -->
            <td class="col-ops">
              <button
                type="button"
                class="ops-btn"
                :title="row.priority ? '取消优先（移到默认）' : '设为优先（固定不下发）'"
                @click="row.priority ? unpick(row.name) : prioritize(row.name)">
                {{ row.priority ? "⬇" : "⬆" }}
              </button>
              <button type="button" class="ops-btn" title="修改名字" @click="startEdit(row)">✎</button>
              <button type="button" class="ops-btn ops-btn-danger" title="删除" @click="askRemove(row.name)">✕</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="admin-state">暂无频道</div>
    </template>

    <AdminModal ref="modal" :title="'确认操作'" tone="primary" confirm-text="确认" />
  </section>
</template>

<script setup lang="ts">
/**
 * 频道管理面板（2026-08-26 CRUD v2：表格版）
 *
 * 全部频道（优先级 + 默认）以表格列出，一行一个频道：
 * - 列：优先级（优先/默认徽标）/ 频道名字（行内改名）/ 操作
 * - 增：顶部输入 + 添加（进入默认）
 * - 删：操作列 ✕（确认弹窗）
 * - 改：✎ 行内改名、⬆/⬇ 切换优先级（保留在两组间移动）
 * - 查：全量列出，更改本地编辑 → 批量「保存全部」（PUT 全量）
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

// 行内编辑状态
const editingName = ref<string | null>(null); // 正在编辑的原频道名
const editValue = ref("");
const editError = ref(false);

/** 表格行：channels 统一列出（优先在前） */
interface ChannelRow {
  name: string;
  priority: boolean;
}
const rows = computed<ChannelRow[]>(() => [
  ...priorityChannels.value.map((name) => ({ name, priority: true })),
  ...defaultChannels.value.map((name) => ({ name, priority: false })),
]);

const version = computed(() => base.value?.version ?? 0);
const allCount = computed(() => rows.value.length);

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
    cancelEdit();
  } catch (e: any) {
    error.value = e?.message || "请求异常";
  } finally {
    loading.value = false;
  }
}

/** 增：添加到默认频道 */
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

/** 删：确认弹窗后从两份清单移除 */
function askRemove(name: string) {
  modalRef.value?.open({
    title: "删除频道",
    message: `确定删除频道「${name}」吗？保存后对所有使用该频道列表的请求生效。`,
    tone: "danger",
    confirmText: "删除",
    onConfirm: async () => {
      priorityChannels.value = priorityChannels.value.filter((c) => c !== name);
      defaultChannels.value = defaultChannels.value.filter((c) => c !== name);
      dirty.value = true;
      if (editingName.value === name) cancelEdit();
    },
  });
}

/** 改：切换优先级（保留在两组间移动） */
function prioritize(name: string) {
  defaultChannels.value = defaultChannels.value.filter((c) => c !== name);
  if (!priorityChannels.value.includes(name)) priorityChannels.value.push(name);
  dirty.value = true;
}
function unpick(name: string) {
  priorityChannels.value = priorityChannels.value.filter((c) => c !== name);
  if (!defaultChannels.value.includes(name)) defaultChannels.value.push(name);
  dirty.value = true;
}

/** 改：开始行内改名 */
function startEdit(row: ChannelRow) {
  editingName.value = row.name;
  editValue.value = row.name;
  editError.value = false;
}
function cancelEdit() {
  editingName.value = null;
  editValue.value = "";
  editError.value = false;
}
function commitEdit(row: ChannelRow) {
  const next = editValue.value.trim();
  if (!next) {
    editError.value = true;
    return;
  }
  if (next === row.name) {
    cancelEdit();
    return;
  }
  // 改名冲突检查（全量频道范围内）
  const others = [...priorityChannels.value, ...defaultChannels.value].filter((c) => c !== row.name);
  if (others.includes(next)) {
    showToast("已存在同名频道", "error");
    editError.value = true;
    return;
  }
  const list = row.priority ? priorityChannels.value : defaultChannels.value;
  const idx = list.indexOf(row.name);
  if (idx >= 0) list.splice(idx, 1, next);
  dirty.value = true;
  cancelEdit();
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
    await load(); // 服务端做了去重/互斥，回读最新
  } catch (e: any) {
    showToast(e?.message || "保存失败", "error");
    throw e; // 保持弹窗显示错误
  } finally {
    saving.value = false;
  }
}

/** 重新加载（放弃本地修改，从远端重拉） */
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
  margin: 16px 0 14px;
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

/* ===== 表格 ===== */
.channel-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}
.channel-table th {
  text-align: left;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-tertiary, #9ca3af);
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-light, #e5dfd0);
  letter-spacing: 0.5px;
}
.channel-table td {
  padding: 9px 12px;
  border-bottom: 1px solid var(--border-light, #eee);
  vertical-align: middle;
}
.channel-table tbody tr:hover { background: var(--bg-hover, rgba(15, 118, 110, 0.03)); }
.col-pri { width: 90px; white-space: nowrap; }
.col-name { min-width: 200px; }
.col-ops { width: 150px; white-space: nowrap; }

.channel-pri-badge {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  border: 1px solid var(--border-light, #e5dfd0);
  color: var(--text-tertiary, #9ca3af);
  background: var(--bg-hover, rgba(0, 0, 0, 0.03));
}
.channel-pri-badge.is-pri {
  background: rgba(15, 118, 110, 0.14);
  border-color: rgba(15, 118, 110, 0.3);
  color: var(--primary, #0f766e);
  font-weight: 600;
}
.channel-name { word-break: break-all; color: var(--text-primary, #1f2937); }

.row-input {
  width: 220px;
  padding: 5px 10px;
  border: 1px solid var(--border-light, #e5dfd0);
  border-radius: 6px;
  font-size: 13px;
  background: var(--bg-primary, #fff);
  color: var(--text-primary, #1f2937);
  margin-right: 6px;
}
.row-input:focus { outline: none; border-color: var(--primary, #0f766e); }
.row-input-invalid, .row-input-invalid:focus {
  border-color: var(--error, #ef4444);
  background: rgba(239, 68, 68, 0.05);
  box-shadow: 0 0 0 1px rgba(239, 68, 68, 0.2);
}

.btn-sm { padding: 3px 10px; font-size: 13px; }
.ops-btn {
  border: none;
  background: transparent;
  color: var(--text-tertiary, #9ca3af);
  cursor: pointer;
  font-size: 13px;
  padding: 4px 7px;
  border-radius: 6px;
  line-height: 1;
  margin-right: 2px;
}
.ops-btn:hover { background: rgba(0, 0, 0, 0.06); color: var(--text-primary, #1f2937); }
.ops-btn-danger:hover { background: rgba(239, 68, 68, 0.12); color: var(--error, #ef4444); }

.admin-empty { padding: 24px 0; text-align: center; color: var(--text-tertiary, #9ca3af); font-size: 14px; }
.admin-notice-warn {
  background: rgba(245, 158, 11, 0.1);
  border: 1px solid rgba(245, 158, 11, 0.35);
  color: #b45309;
}
</style>