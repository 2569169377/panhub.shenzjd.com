/**
 * 热搜存储共享工具函数
 * 被 SqliteHotSearchStore 与 D1HotSearchStore 共用，保证两套存储的
 * 词条规范化、敏感词过滤、北京时间日期语义完全一致。
 */

/** 敏感词过滤（热搜榜单/词库落库前拦截） */
export function isForbidden(term: string): boolean {
  const forbiddenPatterns = [
    /政治|暴力|色情|赌博|毒品/i,
    /fuck|shit|bitch/i,
  ];
  return forbiddenPatterns.some((pattern) => pattern.test(term));
}

/**
 * 词条规范化：
 * - 去首尾空白，空串/纯 URL/超长词丢弃
 * - 全角字符转半角（Ａ-Ｚ → A-Z 等）
 */
export function normalize(term: string): string | null {
  let t = term.trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return null;
  if (t.length > 20) return null;
  t = t.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)
  );
  return t || null;
}

/**
 * 固定北京时间（UTC+8）日期键 YYYY-MM-DD
 * 不依赖宿主时区（Docker/CF 为 UTC 也能对齐用户感知的"今日"）
 */
export function formatDateKey(ts: number): string {
  const d = new Date(ts + 8 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 北京时间 0 点对应的 epoch ms（入参 YYYY-MM-DD） */
export function beijingDayStart(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Date.UTC(y, m - 1, d) - 8 * 3600 * 1000;
}
