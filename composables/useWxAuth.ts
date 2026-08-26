/**
 * 微信公众号认证 composable（2026-08-26 起：写死强制，无开关、无软引导）
 *
 * 决策（用户拍板）：
 * - 所有部署（主站 + fork 站）一律强制"关注公众号 + 验证码"后才能搜索。
 *   不再有 NUXT_PUBLIC_WX_AUTH_ENFORCE 开关，也不再区分"主站强制/fork 软引导"。
 * - 已验证用户：SDK 在【当前域名】写 cookie（wxauth-token 1 年有效），
 *   下次搜索 silentCheck 命中即静默放行，不弹窗。
 * - fork 站用户首次在 fork 站自己域名验证一次后，cookie 就在 fork 域名上，
 *   之后同一域名后续搜索永远静默（不会每搜必弹）。
 *
 * 依赖 wx-auth-sdk 的 silent + required 选项：
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
      // silent: true 会 init 只做 cookie 静默验证（已验证 token 有效 => isAuth；无效 => 删 cookie）
      // 2026-08-25 修复：此前 useWxAuth 在 init 后又手动调一次 silentCheck，
      // 导致首页每次加载发 2 次 /api/auth/check 请求。改为依赖 init 内部
      // 唯一一次 silentCheck，由 onVerified 回调置位 + 5s 超时兜底。
      silent: true,
      // 2026-08-26：恒强制（无开关）——弹窗无关闭按钮、遮罩不可点穿，
      // 必须完成关注+验证码（与后端 requireWxAuth 恒拦截一致）。
      required: true,
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
   * - 已认证（关注公众号且 cookie 有效）=> 直接放行，返回 true（永不弹窗，静默）
   * - 未认证 => 弹出强制认证弹窗（不可关闭），等待完成关注+关注，
   *   验证成功后自动放行（无需再点一次搜索）
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
    void WxAuth.showAuthModal();
    await waitForVerified();
    return isVerified.value;
  }

  /** 等待验证成功（onVerified 回调把 isVerified 置 true 时 resolve） */
  function waitForVerified(): Promise<void> {
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

    await waitForVerified();
    return isVerified.value;
  }

  return {
    isVerified: computed(() => isVerified.value),
    isReady: computed(() => isReady.value),
    checkSearchAuth,
    forceVerify,
  };
}