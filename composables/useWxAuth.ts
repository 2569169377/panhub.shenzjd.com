/**
 * 微信公众号认证 composable
 * - 未关注用户：每次搜索都会弹出认证提示（可点击"×"关闭，不强制关注）
 * - 已认证用户（cookie 存在且有效）永不弹窗
 * - 用户关闭弹窗后搜索正常进行，下次搜索再弹
 *
 * 依赖 wx-auth-sdk@1.2.8+ 的 silent + required=false 选项：
 * - init({ silent: true }) 只做 cookie 静默验证（有效 => onVerified，无效 => 删 cookie），不自动弹窗
 * - required: false 使弹窗带关闭"×"按钮，不强制用户关注
 * 弹窗时机由 checkSearchAuth() 手动控制。
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

    WxAuth.init({
      apiBase: "https://wx-auth.shenzjd.com",
      // silent: true —— init 内部 autoCheck 不会弹窗，只静默验证 cookie
      silent: true,
      // required: false —— 弹窗带关闭"×"，不强制关注
      required: false,
      onVerified: (user: any) => {
        // init 内部 silentCheck + 下方手动 silentCheck 各触发一次，去重
        if (isVerified.value) return;
        console.log("[wx-auth] 认证成功", user);
        isVerified.value = true;
        isReady.value = true;
        silentCheckDone.value = true;
      },
      onError: (error: any) => {
        console.error("[wx-auth] 认证失败", error);
      },
      onClose: () => {
        console.log("[wx-auth] 弹窗关闭");
      },
    });

    // init 内部已异步执行 silentCheck（无 cookie 时同步返回 false）。
    // 再手动调一次拿"验证收敛"的 Promise：已关注用户等它确认 cookie 有效，
    // 未关注用户（无 cookie）立即 resolve，零延迟。
    // 幂等：重复验证只多一次轻量 GET /api/auth/check，副作用可忽略。
    silentCheckPromise = WxAuth.silentCheck().finally(() => {
      silentCheckDone.value = true;
      if (!isReady.value) isReady.value = true;
    });

    if (!isReady.value) isReady.value = true;
  });

  /**
   * 每次搜索前调用：
   * - 已认证（关注公众号且 cookie 有效）=> 永不弹窗，返回 false
   * - 未认证 => 弹出认证弹窗（可关闭，不阻塞搜索），返回 true
   */
  async function checkSearchAuth(): Promise<boolean> {
    if (typeof window === "undefined") return false;

    // 等待静默验证收敛（最长等一次请求的完成），避免对已关注用户误弹窗
    if (!silentCheckDone.value) {
      await silentCheckPromise;
    }

    // 已认证（cookie 有效）→ 相当于已登录，不再弹
    if (isVerified.value) return false;

    // 未认证 → 每次搜索都弹，可点击"×"关闭，不强制关注
    showAuthModal();
    return true;
  }

  /** 显示认证弹窗（手动触发，走 SDK 内部 showAuthModal） */
  function showAuthModal() {
    WxAuth.showAuthModal();
  }

  return {
    isVerified: computed(() => isVerified.value),
    isReady: computed(() => isReady.value),
    checkSearchAuth,
  };
}
