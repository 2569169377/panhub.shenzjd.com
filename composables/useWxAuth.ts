/**
 * 微信公众号认证 composable（强制模式）
 * - 未认证用户：搜索时强制弹出认证，弹窗无关闭按钮，必须完成
 *   关注公众号 + 验证码验证后才能继续搜索（验证成功后自动继续）
 * - 已认证用户（cookie 存在且有效）永不弹窗
 *
 * 依赖 wx-auth-sdk@1.2.8+ 的 silent + required 选项：
 * - init({ silent: true }) 只做 cookie 静默验证（有效 => onVerified，无效 => 删 cookie），不自动弹窗
 * - required: true 强制认证：弹窗无关闭"×"、遮罩不可点穿，必须完成验证
 * 弹窗时机由 checkSearchAuth() 手动控制（未认证时 await 阻塞直到验证完成）。
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
      // required: true —— 强制认证：弹窗无关闭按钮，遮罩不可点穿
      required: true,
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
   * 每次搜索前调用（强制认证）：
   * - 已认证（关注公众号且 cookie 有效）=> 直接放行，返回 true
   * - 未认证 => 弹出强制认证弹窗（不可关闭），等待用户完成关注+验证码
   *   验证，验证成功后自动放行（无需再点一次搜索）
   */
  async function checkSearchAuth(): Promise<boolean> {
    if (typeof window === "undefined") return false;

    // 等待静默验证收敛（最长等一次请求的完成），避免对已关注用户误弹窗
    if (!silentCheckDone.value) {
      await silentCheckPromise;
    }

    // 已认证（cookie 有效）→ 相当于已登录，直接放行
    if (isVerified.value) return true;

    // 未认证 → 弹出强制认证弹窗（required:true 无关闭按钮）。
    // 注意：不用 await WxAuth.requireAuth() 的返回值——SDK verifyCode 成功
    // 路径是 close() 先 resolve(false) 再 onVerified()（resolveAuth 已被置
    // null 无法覆盖），requireAuth 的 Promise 恒为 false，会误判"未认证"
    // 跳过搜索。改为等 onVerified 回调置位 isVerified 的信号。
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

  return {
    isVerified: computed(() => isVerified.value),
    isReady: computed(() => isReady.value),
    checkSearchAuth,
  };
}
