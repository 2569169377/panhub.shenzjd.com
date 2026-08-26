<script setup lang="ts">
/**
 * PanHub 管理面板（2026-08-25 v2 规范化重构）
 *
 * 布局：layouts/admin.vue 负责顶栏 + 侧栏 + 面包屑 + 菜单高亮（activeKey），
 *       本页只负责内容区：根据 activeKey 渲染对应面板，并处理鉴权门槛。
 * 鉴权（沿用定稿）：打开页面即探测（无 token 兜底 silentCheck → 管理员接口判定）。
 * 401 → 未登录提示；403 → 非管理员提示；ok 才渲染面板。
 */
import { useAdminApi } from "~/composables/useAdminApi";
import { ADMIN_NAV_KEY } from "~/utils/adminKeys";
import OverviewPanel from "~/components/admin/OverviewPanel.vue";
import SearchRecordPanel from "~/components/admin/SearchRecordPanel.vue";
import BlacklistPanel from "~/components/admin/BlacklistPanel.vue";
import ChannelPanel from "~/components/admin/ChannelPanel.vue";

definePageMeta({
  title: "PanHub 管理",
  layout: "admin",
});
useSeoMeta({
  title: "PanHub 管理",
  robots: "noindex,nofollow", // 管理页禁止收录
});

const { authStatus, probeAuth } = useAdminApi();

/** 布局注入的当前激活菜单（响应式） */
const nav = inject<{ activeKey: Ref<string>; setActive: (k: string) => void }>(ADMIN_NAV_KEY);
const activeKey = computed(() => nav?.activeKey.value ?? "overview");

/** 面板联动：搜索记录里拉黑后，通知黑名单面板刷新（若已挂载） */
const blPanel = ref<InstanceType<typeof BlacklistPanel>>();
function onBlocked() {
  blPanel.value?.refresh?.();
}

onMounted(async () => {
  await probeAuth(); // 无 token 时兜底 silentCheck，补齐 wxauth cookie
});
</script>

<template>
  <div class="admin-page">
    <!-- 鉴权状态（检测/未登录/无权限） -->
    <div v-if="authStatus === 'checking'" class="admin-state">正在检测登录状态…</div>
    <div v-else-if="authStatus === 'no-login'" class="admin-notice admin-notice-error">
      <strong>请先登录</strong>：管理页需要微信关注公众号登录态。
      <NuxtLink to="/" class="admin-link">去首页完成关注验证 →</NuxtLink>
    </div>
    <div v-else-if="authStatus === 'no-admin'" class="admin-notice admin-notice-error">
      <strong>无权限访问</strong>：当前账号不是管理员。请在 wx-auth 后台将该账号标记为管理员后重试。
    </div>

    <!-- 正常内容 -->
    <template v-else>
      <OverviewPanel v-if="activeKey === 'overview'" />
      <ChannelPanel v-else-if="activeKey === 'channels'" />
      <SearchRecordPanel v-else-if="activeKey === 'search-log'" @blocked="onBlocked" />
      <BlacklistPanel v-else-if="activeKey === 'blacklist'" ref="blPanel" />
    </template>
  </div>
</template>