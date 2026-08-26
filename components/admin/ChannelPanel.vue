<template>
  <section class="admin-card">
    <div class="admin-card-head">
      <div>
        <h2>频道管理</h2>
        <p class="admin-card-desc">
          全部频道 {{ allCount }} 个 · 固定 {{ priorityCount }} + 搜索 {{ defaultCount }} ·
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
        v-model="newId"
        type="text"
        class="channel-input"
        placeholder="输入频道 ID（TG 用户名），如 tgsearchers3"
        :disabled="saving"
        @keyup.enter="addChannel"
      />
      <input
        v-model="newDisplay"
        type="text"
        class="channel-input channel-input-sm"
        placeholder="频道名字（备注，可选）"
        :disabled="saving"
        @keyup.enter="addChannel"
      />
      <button type="button" class="btn btn-neutral" :disabled="saving || !newId.trim()" @click="addChannel">
        + 添加频道
      </button>
    </div>

    <div v-if="loading" class="admin-state">加载中…</div>
    <template v-else>
      <p v-if="dirty" class="admin-notice admin-notice-warn">
        有未保存的修改，点击「保存全部」生效
      </p>
      <p class="channel-tip">
        <b>固定</b>：不下发给第三方站、也不参与本站搜索；<b>搜索</b>：按表格顺序逐批搜索，
        排在前面的频道更早发起请求。可用 ↑↓ 调整搜索顺序。
      </p>

      <div v-if="rows.length" class="channel-table-wrap">
        <table class="channel-table">
          <thead>
            <tr>
              <th class="col-pri">固定下发</th>
              <th class="col-id">频道 ID</th>
              <th class="col-name">频道名字</th>
              <th class="col-ops">操作</th>
            </tr>
          </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id">
            <!-- 固定下发 -->
            <td class="col-pri">
              <span :class="['channel-pri-badge', { 'is-pri': row.priority }]">
                {{ row.priority ? "固定" : "搜索" }}
              </span>
            </td>
            <!-- 频道 ID（不可改） -->
            <td class="col-id channel-id" :title="row.id">{{ row.id }}</td>
            <!-- 频道名字（备注，可编辑） -->
            <td class="col-name">
              <input
                v-model="row.name"
                type="text"
                class="row-input"
                :placeholder="'未备注'"
                :disabled="saving"
                @input="onNameInput(row)"
              />
            </td>
            <!-- 操作 -->
            <td class="col-ops">
              <!-- 排序（仅"搜索"频道：组内上移/下移，数组顺序 = 搜索顺序） -->
              <template v-if="!row.priority">
                <button
                  type="button"
                  class="ops-btn"
                  :disabled="isFirstOfGroup(row)"
                  title="上移（搜索更靠前）"
                  @click="moveRow(row, -1)">
                  ↑
                </button>
                <button
                  type="button"
                  class="ops-btn"
                  :disabled="isLastOfGroup(row)"
                  title="下移（搜索更靠后）"
                  @click="moveRow(row, 1)">
                  ↓
                </button>
              </template>
              <!-- 固定 ⇄ 搜索 切换 -->
              <button
                type="button"
                class="ops-btn"
                :title="row.priority ? '取消固定（参与搜索）' : '设为固定（不下发且不参与搜索）'"
                @click="row.priority ? unpick(row.id) : prioritize(row.id)">
                {{ row.priority ? "◁" : "📌" }}
              </button>
              <button type="button" class="ops-btn ops-btn-danger" title="删除" @click="askRemove(row.id)">✕</button>
            </td>
          </tr>
        </tbody>
        </table>
      </div>
      <p v-if="rows.length > 12" class="channel-table-hint">↑ 表格内部滚动 · 共 {{ rows.length }} 个频道</p>
      <div v-else-if="rows.length === 0" class="admin-empty">暂无频道</div>
    </template>

    <AdminModal ref="modal" :title="'确认操作'" tone="primary" confirm-text="确认" />
  </section>
</template>

<script setup lang="ts">
/**
 * 频道管理面板（2026-08-26 CRUD v3：ID + 备注名表格）
 *
 * 表格列：优先级 / 频道 ID（不可改，即 TG username）/ 频道名字（备注，可编辑）

 *  - 增：顶部输入 ID + 可选名字，添加进默认频道
 *  - 删：操作列 ✕（确认弹窗）
 *  - 改：EDshift 名字输入框直接编辑、⬆/⬇ 切换优先级、删除
 *  - 查：全量列出（优先在前）
 * 本地编辑 → 批量「保存全部」（PUT 全量，含 channelNames）
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
const newId = ref("");
const newDisplay = ref("");

const base = ref<ChannelAdminData | null>(null);

/** 表格行：channel id + 备注名 + 优先级 */
interface ChannelRow {
  id: string;
  name: string; // 备注名（可为空）
  priority: boolean;
}
const rows = ref<ChannelRow[]>([]);

const version = computed(() => base.value?.version ?? 0);
const allCount = computed(() => rows.value.length);
const priorityCount = computed(() => rows.value.filter((r) => r.priority).length);
const defaultCount = computed(() => rows.value.filter((r) => !r.priority).length);

/** 从后端数据构建表格行 */
function buildRows(data: ChannelAdminData): ChannelRow[] {
  const names = data.channelNames ?? {};
  const pri = data.priorityChannels.map((id) => ({ id, name: names[id] ?? "", priority: true }));
  const def = data.defaultChannels.map((id) => ({ id, name: names[id] ?? "", priority: false }));
  return [...pri, ...def];
}

/** 加载服务器最新配置 */
async function load() {
  loading.value = true;
  error.value = "";
  reloadMsg.value = "";
  try {
    const data = await loadChannels();
    base.value = data;
    rows.value = buildRows(data);
    dirty.value = false;
  } catch (e: any) {
    error.value = e?.message || "请求异常";
  } finally {
    loading.value = false;
  }
}

/** 增：添加到默认频道 */
function addChannel() {
  const id = newId.value.trim();
  if (!id) return;
  if (rows.value.some((r) => r.id === id)) {
    showToast("该频道已存在", "error");
    return;
  }
  rows.value.push({ id, name: newDisplay.value.trim(), priority: false });
  newId.value = "";
  newDisplay.value = "";
  dirty.value = true;
}

/** 删：确认弹窗后移除 */
function askRemove(id: string) {
  const row = rows.value.find((r) => r.id === id);
  modalRef.value?.open({
    title: "删除频道",
    message: `确定删除频道「${row?.name || id}」（${id}）吗？保存后对所有使用该频道列表的请求生效。`,
    tone: "danger",
    confirmText: "删除",
    onConfirm: async () => {
      rows.value = rows.value.filter((r) => r.id !== id);
      dirty.value = true;
    },
  });
}

/** 备注输入时标记脏 */
function onNameInput(_row: ChannelRow) {
  dirty.value = true;
}

/** 设为固定（移到固定组末尾） */
function prioritize(id: string) {
  const row = rows.value.find((r) => r.id === id);
  if (row) row.priority = true;
  sortRows();
  dirty.value = true;
}
/** 取消固定（移到搜索组末尾，即最后搜） */
function unpick(id: string) {
  const row = rows.value.find((r) => r.id === id);
  if (row) row.priority = false;
  sortRows();
  dirty.value = true;
}

/** 保持固定在前、搜索在后（组内相对顺序不变；稳定排序） */
function sortRows() {
  rows.value = [...rows.value].sort((a, b) => Number(b.priority) - Number(a.priority));
}

/** 搜索组内第一个 / 最后一个？ */
function isFirstOfGroup(row: ChannelRow): boolean {
  const group = rows.value.filter((r) => !r.priority);
  return group.length <= 1 || group[0].id === row.id;
}
function isLastOfGroup(row: ChannelRow): boolean {
  const group = rows.value.filter((r) => !r.priority);
  return group.length <= 1 || group[group.length - 1].id === row.id;
}

/** 搜索组内上移/下移（数组顺序 = 搜索顺序） */
function moveRow(row: ChannelRow, dir: -1 | 1) {
  const idx = rows.value.findIndex((r) => r.id === row.id);
  if (idx < 0) return;
  const next = idx + dir;
  // 只能在同一组内移动：不能越过固定/搜索的分界
  if (next < 0 || next >= rows.value.length) return;
  const target = rows.value[next];
  if (target.priority !== row.priority) return; // 跨组不允许
  const copy = [...rows.value];
  copy[idx] = target;
  copy[next] = row;
  rows.value = copy;
  dirty.value = true;
}

/** 保存全部 */
function askSave() {
  modalRef.value?.open({
    title: "保存频道配置",
    message: `将保存为 v${version.value + 1}：固定下发 ${priorityCount.value} 个、参与搜索 ${defaultCount.value} 个。\n保存后立即对所有请求生效。`,
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
    // 组装 channelNames（仅保留非空备注）
    const channelNames: Record<string, string> = {};
    for (const r of rows.value) {
      const name = r.name.trim();
      if (name) channelNames[r.id] = name;
    }
    const r = await saveChannels({
      priorityChannels: rows.value.filter((x) => x.priority).map((x) => x.id),
      defaultChannels: rows.value.filter((x) => !x.priority).map((x) => x.id),
      channelNames,
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
}
.channel-input {
  flex: 1;
  min-width: 0;
  padding: 8px 12px;
  border: 1px solid var(--border-light, #e5dfd0);
  border-radius: 8px;
  background: var(--bg-primary, #fff);
  color: var(--text-primary, #1f2937);
  font-size: 14px;
}
.channel-input-sm { max-width: 200px; }
.channel-input:focus { outline: none; border-color: var(--primary, #0f766e); }

/* ===== 表格 ===== */
.channel-table-wrap {
  max-height: 460px; /* 内部滚动，避免 77 个频道撑长整页 */
  overflow-y: auto;
  border: 1px solid var(--border-light, #e5dfd0);
  border-radius: 10px;
  position: relative;
}
.channel-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}
.channel-table thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--bg-primary, #fffdf8);
  box-shadow: 0 1px 0 var(--border-light, #e5dfd0);
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
  padding: 7px 12px;
  border-bottom: 1px solid var(--border-light, #eee);
  vertical-align: middle;
}
.channel-table tbody tr:hover { background: var(--bg-hover, rgba(15, 118, 110, 0.03)); }
.channel-table tbody tr:nth-child(even) { background: var(--bg-hover, rgba(15, 118, 110, 0.025)); }
.col-pri { width: 70px; white-space: nowrap; }
.col-id { width: 180px; }
.col-name { min-width: 200px; }
.col-ops { width: 90px; white-space: nowrap; }

.channel-pri-badge {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  border: 1px solid var(--border-light, #e5dfd0);
  color: var(--text-tertiary, #9ca3af);
  background: var(--bg-hover, rgba(0, 0, 0, 0.03));
}
/* 表格内部滚动的滚动条美化（WebKit） */
.channel-table-wrap::-webkit-scrollbar { width: 10px; }
.channel-table-wrap::-webkit-scrollbar-thumb {
  background: var(--border-strong, #d6cdb8);
  border-radius: 999px;
  border: 2px solid var(--bg-primary, #fffdf8);
}
.channel-table-wrap::-webkit-scrollbar-thumb:hover { background: var(--text-tertiary, #9ca3af); }
.channel-table-wrap::-webkit-scrollbar-track { background: transparent; }
.channel-table-hint {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-tertiary, #9ca3af);
}
.channel-pri-badge.is-pri {
  background: rgba(15, 118, 110, 0.14);
  border-color: rgba(15, 118, 110, 0.3);
  color: var(--primary, #0f766e);
  font-weight: 600;
}
.channel-id {
  color: var(--text-secondary, #4b5563);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  word-break: break-all;
}
.row-input {
  width: 100%;
  max-width: 260px;
  padding: 5px 10px;
  border: 1px solid transparent;
  border-radius: 6px;
  font-size: 13px;
  background: transparent;
  color: var(--text-primary, #1f2937);
}
.row-input:hover { border-color: var(--border-light, #e5dfd0); background: var(--bg-primary, #fff); }
.row-input:focus {
  outline: none;
  border-color: var(--primary, #0f766e);
  background: var(--bg-primary, #fff);
}
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
.channel-tip {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-tertiary, #9ca3af);
  background: var(--bg-hover, rgba(15, 118, 110, 0.04));
  border-radius: 8px;
  padding: 8px 12px;
}
.channel-tip b { color: var(--text-secondary, #4b5563); font-weight: 600; }
.ops-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
  background: transparent;
  color: var(--text-tertiary, #9ca3af);
}
</style>