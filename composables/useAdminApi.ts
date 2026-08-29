/**
 * 管理后台 API 封装（2026-08-25 admin 规范化重构）
 *
 * 统一处理：
 * - /api/search-log：搜索记录查询（按 openid / 按词）
 * - /api/blacklist：黑名单查询 / 手动拉黑 / 移除
 * - 鉴权状态：401 → no-login（未登录）、403 → no-admin（非管理员）、
 *   其他错误 → 抛出含 message 的 Error
 *
 * 页面只需关心返回数据，不用重复写状态码分支。
 */

export type AdminAuthStatus = "checking" | "ok" | "no-login" | "no-admin";

/** 搜索记录条目 */
export interface SearchLogItem {
  term?: string;
  openid?: string;
  ip?: string;
  createdAt?: number;
}

/** 黑名单条目 */
export interface BlacklistItem {
  ip: string;
  reason?: string;
  hitCount?: number;
  blockCount?: number;
  firstAt?: number;
  lastAt?: number;
  expiresAt?: number;
  blocked?: boolean;
  remainingMs?: number;
}

/** 频道配置（管理面板全量视图，含 priority） */
export interface ChannelAdminData {
  version: number;
  priorityChannels: string[];
  defaultChannels: string[];
  /** 频道备注名映射（ID → 显示名/备注），可空 */
  channelNames: Record<string, string>;
  priorityCount: number;
  defaultCount: number;
}

/** 409 之外的错误会被包装为 AdminApiError（serverMessage 来自后端 message） */
export class AdminApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
  }
}

export function useAdminApi() {
  const authStatus = ref<AdminAuthStatus>("checking");

  async function request<T = any>(url: string, init?: RequestInit): Promise<T> {
    // credentials: "same-origin" 显式声明：管理接口靠 wxauth-token cookie 鉴权，
    // 必须确保每次请求携带 cookie（同源默认也带，但显式声明排除一切边角情况）
    const res = await fetch(url, { ...init, credentials: "same-origin" });
    if (res.status === 401) {
      authStatus.value = "no-login";
      throw new AdminApiError(401, "未登录");
    }
    if (res.status === 403) {
      authStatus.value = "no-admin";
      throw new AdminApiError(403, "无权限");
    }
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new AdminApiError(res.status, data?.message || `请求失败（HTTP ${res.status}）`);
    }
    const data = await res.json();
    if (data?.code !== 0) {
      throw new AdminApiError(200, data?.message || "业务处理失败");
    }
    return data.data as T;
  }

  /** 打开管理页即探测管理员权限（onMounted 调用：先补齐 cookie，再探测） */
  async function probeAuth(): Promise<AdminAuthStatus> {
    authStatus.value = "checking";
    try {
      // 先调一次 wx-auth SDK 静默检查：把 localStorage 备份的 token 落回 cookie，
      // 或验证无有效凭证（silentCheck 对无 cookie 是幂等安全返回 false）。
      // 此前优化"有 wxauth-token cookie 就跳过"有个隐患：SDK 可能凭 localStorage
      // 残留通过 silentCheck 写 cookie，但若写失败/被清，则出现"内存有 token、
      // cookie 没有"——搜索能过（token 兜底），管理接口却 401（只认 token cookie）。
      // 2026-08-29：SDK 走 UMD 全局单例（resolveWxAuth 等待就绪，admin 布局
      // 没引脚本时会自行补插）。加载失败仅跳过补 cookie，不影响后续接口
      // 探测（401 走 no-login 兜底）。
      const wxAuth = await resolveWxAuth().catch(() => null);
      if (wxAuth) await wxAuth.silentCheck().catch(() => {});
      // 探测：拉一次黑名单（管理员接口），成功即管理员
      await request("/api/blacklist?limit=1");
      authStatus.value = "ok";
    } catch (e: any) {
      // 401/403 已被 request 写入 authStatus，其余（网络异常）保持 checking → 走 no-login 兜底
      if (authStatus.value === "checking") authStatus.value = "no-login";
    }
    return authStatus.value;
  }

  /** 搜索记录查询 */
  async function querySearchLog(opts: {
    mode: "openid" | "term" | "ip";
    keyword: string;
    days?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ mode: string; items: SearchLogItem[]; total: number }> {
    const q = new URLSearchParams();
    q.set(opts.mode, opts.keyword.trim());
    q.set("limit", String(opts.limit ?? 100));
    if (opts.offset) q.set("offset", String(opts.offset));
    if (opts.days) q.set("days", opts.days);
    return request(`/api/search-log?${q.toString()}`);
  }

  /** 黑名单列表（支持 IP 模糊搜索、状态筛选、分页） */
  async function loadBlacklist(opts: {
    limit?: number;
    offset?: number;
    ip?: string;
    status?: "blocked" | "free" | "";
  } = {}): Promise<{ now: number; items: BlacklistItem[]; total: number }> {
    const q = new URLSearchParams();
    q.set("limit", String(opts.limit ?? 100));
    if (opts.offset) q.set("offset", String(opts.offset));
    if (opts.ip?.trim()) q.set("ip", opts.ip.trim());
    if (opts.status) q.set("status", opts.status);
    return request(`/api/blacklist?${q.toString()}`);
  }

  /** 手动拉黑 */
  async function blockIp(ip: string, reason = "manual"): Promise<{ blockCount: number }> {
    return request("/api/blacklist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ip, reason }),
    });
  }

  /** 移除黑名单 */
  async function removeIp(ip: string): Promise<{ removed: boolean }> {
    return request(`/api/blacklist?ip=${encodeURIComponent(ip)}`, { method: "DELETE" });
  }

  /** 频道配置全量（含 priority 频道） */
  async function loadChannels(): Promise<ChannelAdminData> {
    return request("/api/admin/channels");
  }

  /** 频道配置全量保存（CRUD 提交：priority/default 互斥已由服务端处理） */
  async function saveChannels(payload: {
    priorityChannels: string[];
    defaultChannels: string[];
    channelNames?: Record<string, string>;
  }): Promise<{ version: number; priorityCount: number; defaultCount: number }> {
    return request("/api/admin/channels", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  /** 频道配置重载（强制重新拉取，不重启进程） */
  async function reloadChannels(): Promise<{
    version: number;
    priorityCount: number;
    defaultCount: number;
  }> {
    return request("/api/admin/channels/reload", { method: "POST" });
  }

  /** 流量概览统计（搜索 + 黑名单两块聚合，只读） */
  async function loadStats(): Promise<{
    search: {
      todayCount: number;
      todayTerms: number;
      trend: { date: string; count: number }[];
      topTerms: { term: string; count: number }[];
    };
    defense: {
      total: number;
      blocked: number;
      todayActive: number;
      topIps: {
        ip: string;
        reason: string;
        hitCount: number;
        blockCount: number;
        expiresAt: number;
      }[];
    };
  }> {
    return request("/api/admin/stats");
  }

  return { authStatus, probeAuth, request, querySearchLog, loadBlacklist, blockIp, removeIp, loadChannels, saveChannels, reloadChannels, loadStats };
}