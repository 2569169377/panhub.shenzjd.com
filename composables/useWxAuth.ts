/**
 * 微信公众号认证 composable（双模式：强制 / 软引导）
 *
 * 模式由运行时配置 public.wxAuthEnforce 决定（= NUXT_PUBLIC_WX_AUTH_ENFORCE 环境变量，
 * 独立于后端 WX_AUTH_ENFORCE，避免 build 阶段拿不到 env 的问题）：
 * - NUXT_PUBLIC_WX_AUTH_ENFORCE=1（主站）→ checkSearchAuth() 对未认证用户强制弹认证，
 *   无关闭按钮、必须完成关注+验证码才能搜索（当前服务端 WX_AUTH_ENFORCE=1 也会
 *   401 拦截）。已认证用户（cookie 有效）永不弹窗。
 * - 未设置/=0（fork 版默认）→ 软引导：未认证用户搜索时每个新会话（刷新/新标签页）
 *   弹一次可选认证弹窗（可关闭，sessionStorage 记一次），不强制；已认证用户永不弹窗。
 *   fork 站默认零配置即"不强制 + cookie 有效免验证码"，避免每搜必弹。
 *
 * 依赖 wx-auth-sdk@1.2.8+ 的 silent + required 选项：
 * - init({ silent: true }) 只做 cookie 静默验证（有效 => onVerified，无效 => 删 cookie），不自动弹窗
 * - required: true 强制认证：弹窗无关闭"×"、遮罩不可点穿，必须完成验证
 * 弹窗时机由 checkSearchAuth() 手动控制（强制时 await 阻塞直到验证完成）。
 */

import { WxAuth } from "wx-auth-sdk";
import "wx-auth-sdk/dist/style.css";

export function useWxAuth() {
  const isVerified = ref(false);
  const isReady = ref(false);

  // 静默验证的收敛信号：认证成功（onVerified）或已确认无有效 cookie
  // （silentCheck 无 cookie 时同步返回，不触发任何回调），用于避免对
  // 已关注用户的首搜误弹窗。
  const silentCheckDone = ref(false);
  let silentCheckPromise: Promise<boolean> = Promise.resolve(false);

  // 是否强制（= 主站 NUXT_PUBLIC_WX_AUTH_ENFORCE=1）：
  // 由 nuxt runtimeConfig.public.wxAuthEnforce 注入（与后端 requireWxAuth 同一开关）。
  // ⚠️ destr 类型坑（2026-08-26 复盘实证）：Nuxt 环境变量覆盖经 destr 解析——
  //   "true" → boolean true，"1" → number 1，都【不是】字符串。若默认值声明的类型
  //   与 workspace 侧 env 形态不同，覆盖后类型会漂移。必须宽松四态判断：
  //   boolean true / boolean "1"转的数字 1 / string "1" / string "true"。
  const wxAuthEnforceRaw: unknown = useRuntimeConfig().public.wxAuthEnforce;
  const enforce =
    wxAuthEnforceRaw === true ||
    wxAuthEnforceRaw === 1 ||
    wxAuthEnforceRaw === "1" ||
    wxAuthEnforceRaw === "true";

  // 仅在客户端初始化
  onBeforeMount(() => {
    if (typeof window === "undefined") return;

    // 完成收敛的兜底：silentCheck 失败时 onVerified 不会触发，
    // 必须用 isReady 强制置位，否则 isReady 永远 false → 调用方 await 挂起
    const resolveReady = () => {
      if (!silentCheckDone.value) silentCheckDone.value = true;
      if (!isReady.value) isReady.value = true;
    };
    const failTimer = setTimeout(resolveReady, 5000);

    WxAuth.init({
      apiBase: "https://wx-auth.shenzjd.com",
      // silent: true 会 init 只做 cookie 静默验证（已验证 token 有效 => onVerified；无效 => 删 cookie）
      // 2026-08-25 修复：此前 useWxAuth 在 init 后又手动调一次 silentCheck，
      // 导致首页每次加载发 2 次 /api/auth/check 请求。改为依赖 init 内部
      // 唯一一次 silentCheck，由 onVerified 回调置位 + 5s 超时兜底。
      silent: true,
      // required: enforce —— 主站（enforce=true）强制：无关闭按钮、遮罩不可点穿，
      // 必须完成关注+验证码（与后端 requireWxAuth 实时拦截一致）；
      // fork 版（enforce=false）可关闭、软引导不阻塞。
      required: enforce,
      onVerified: (user: any) => {
        if (isVerified.value) return;
        console.log("[wx-auth] 认证成功", user);
        isVerified.value = true;
        clearTimeout(failTimer);
        resolveReady();
      },
      onError: (error: any) => {
        console.error("[wx-auth] 认证失败", error);
        clearTimeout(failTimer);
        resolveReady();
      },
      onClose: () => {
        console.log("[wx-auth] 弹窗关闭");
      },
    });
  });

  /**
   * 每次搜索前调用：
   * - 已认证（关注公众号且 cookie 有效）=> 直接放行，返回 true（永不弹窗）
   * - 未认证：
   *   - enforce=true（主站）=> 弹出强制认证弹窗（不可关闭），等待完成关注+验证码，
   *     验证成功后自动放行（无需再点一次搜索）
   *   - enforce=false（fork 版默认）=> 软引导：只弹一次可选认证弹窗（可关闭），
   *     不阻塞搜索；验证成功后人记住 cookie，后续搜索不再弹
   */
  async function checkSearchAuth(): Promise<boolean> {
    // 本地开发（npm run dev）不强制关注公众号，直接放行
    if (import.meta.dev) return true;
    if (typeof window === "undefined") return false;

    // 等待静默验证收敛（最长等一次请求的完成），避免对已关注用户误弹窗
    if (!silentCheckDone.value) {
      await silentCheckPromise;
    }

    // 已认证（cookie 有效）→ 相当于已登录，直接放行
    if (isVerified.value) return true;

    // 未认证：
    // 注意：不用 await WxAuth.requireAuth() 的返回值——SDK verifyCode 成功
    // 路径是 close() 先 resolve(false) 再 onVerified()（resolveAuth 已被置
    // null 无法覆盖），requireAuth 的 Promise 恒为 false，会误判"未认证"
    // 跳过搜索。改为等 onVerified 回调置位 isVerified 的信号。

    if (!enforce) {
      // 软引导：每个新会话（标签页/刷新）仅弹一次可关闭的引导窗
      // （展示关注二维码 + 验证码入口），关掉后本会话不再弹。
      // 用 sessionStorage 记录（关闭标签页即清除）——不永久"永不打扰"，
      // 下次回访/刷新会再给一次关注入口，兼顾转化与打扰控制。
      // 用户愿意关注就扫描输入验证码 → SDK 写 1 年长期 cookie → 从此免验证。
      // 关注与否都立即放行搜索（不阻塞）。
      const remindedKey = "wxauth-soft-reminded-session";
      let reminded = false;
      try {
        reminded = sessionStorage.getItem(remindedKey) === "1";
      } catch {}
      if (!reminded) {
        void WxAuth.showAuthModal();
        // 停留 ~1.5s 让用户看到二维码/引导，随即自动放行搜索（弹窗仍可手动关闭）
        await new Promise((r) => setTimeout(r, 1500));
        try {
          sessionStorage.setItem(remindedKey, "1");
        } catch {}
      }
      return true;
    }

    // 强制模式：弹常驻认证窗（SDK required=true 无关闭按钮、遮罩不可点穿），
    // 等用户完成关注+验证码认证后才放行搜索
    void WxAuth.showAuthModal();
    await waitVerified();
    return isVerified.value;
  }

  /** 等待验证成功（onVerified 回调把 isVerified 置 true 时 resolve） */
  function waitVerified(): Promise<void> {
    return new Promise((resolve) => {
      const stop = watch(isVerified, (v) => {
        if (v) {
          stop();
          resolve();
        }
      });
    });
  }

  /**
   * 强制重新认证（服务端 401 时调用，2026-08-22）：
   * - 服务端 requireWxAuth 实时校验失败（token 失效/取消关注）返回 401，
   *   但前端 isVerified 缓存仍为 true，checkSearchAuth 会误判"已认证"放行。
   * - 因此重置 isVerified=false 强制弹窗，用户重新完成关注+验证码，
   *   SDK 会写入新 token，后续搜索恢复正常。
   */
  async function forceVerify(): Promise<boolean> {
    // 本地开发（npm run dev）不强制关注公众号，直接放行
    if (import.meta.dev) return true;
    if (typeof window === "undefined") return false;
    isVerified.value = false; // 强制重新认证
    void WxAuth.showAuthModal();

    if (!enforce) {
      // 配置错配兜底：若某 fork/主站后端开了 WX_AUTH_ENFORCE=1 但前端没开
      // NUXT_PUBLIC_WX_AUTH_ENFORCE（软引导），服务端 401 也会走 forceVerify。
      // 软引导窗可关闭，等 1.5s 就放行（本就可关），避免用户关窗后永久卡死。
      await new Promise((r) => setTimeout(r, 1500));
      return true;
    }

    await waitVerified();
    return isVerified.value;
  }

  return {
    isVerified: computed(() => isVerified.value),
    isReady: computed(() => isReady.value),
    checkSearchAuth,
    forceVerify,
  };
}
