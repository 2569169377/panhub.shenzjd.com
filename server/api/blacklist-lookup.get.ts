import { defineEventHandler, getQuery, createError } from "h3";
import { getOrCreateBotDefenseService } from "../core/services/botDefense";
import { isAdminUser, getWxAuthCredential } from "../utils/wxAuthCheck";

/**
 * 黑名单 openid 反查 API（2026-09-03 用户反馈解封闭环）
 *
 * 背景：黑名单只按 IP 记录，蜜罐拦截在 requireWxAuth 之前。真实用户
 * （带有效凭证）若所在 IP 被封（共享出口 NAT / 公司出口被爬虫拖累），
 * 会被直接喂蜜罐，但 openid 从未解析、search_log 也不记录——用户拿 openid
 * 找管理员反馈"我看到了蜜罐数据"时，后台无从定位他被哪个 IP 蜜罐了。
 *
 * 本接口把蜜罐命中时异步记录的 honeypot_hits(openid↔ip) 反查出来，
 * 并附上各 IP 当前的封禁状态，管理员据此确认"就是它"后一键解封。
 *
 * 用法（管理员）：
 *   GET /api/blacklist-lookup?openid=<openid>&limit=20
 *     → 该 openid 最近命中过蜜罐的 IP + 各 IP 黑名单状态（反馈解封主路径）
 *   GET /api/blacklist-lookup?ip=<IP>&limit=20
 *     → 该 IP 最近影响了哪些 openid（黑名单条目"谁被这个 IP 蜜罐过"）
 *
 * 鉴权：与 /api/blacklist 一致 —— wx-auth isAdminUser。
 *
 * DB 读优化：最多 2 次查询（honeypot_hits 一次 + rejected_ips 一次 IN 批量），
 * 不随命中数线性放大；管理侧低频调用，不做额外缓存。
 */
export default defineEventHandler(async (event) => {
  if (!getWxAuthCredential(event).token) {
    throw createError({ statusCode: 401, statusMessage: "wx auth required" });
  }
  if (!(await isAdminUser(event))) {
    throw createError({ statusCode: 403, statusMessage: "forbidden" });
  }

  const q = getQuery(event);
  const openid = String(q.openid || "").trim().slice(0, 128);
  const ip = String(q.ip || "").trim().slice(0, 64);
  const limitRaw = parseInt(String(q.limit || "20"), 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 100) : 20;

  const given = [openid, ip].filter(Boolean).length;
  if (given !== 1) {
    throw createError({ statusCode: 400, statusMessage: "openid / ip 只能二选一" });
  }

  const service = getOrCreateBotDefenseService();
  const now = Date.now();

  if (openid) {
    // openid → 其命中过蜜罐的 IP 列表 + 各 IP 黑名单状态
    const hits = await service.listHoneypotByOpenid(openid, limit);
    const ips = hits.map((h) => h.ip);
    const statusMap = new Map(
      (await service.listStatusByIps(ips)).map((s) => [s.ip, s])
    );
    const items = hits.map((h) => {
      const s = statusMap.get(h.ip);
      const blocked = !!s && s.blockCount > 0 && s.expiresAt > now;
      return {
        ip: h.ip,
        honeypotHits: h.hits,
        honeypotLastAt: h.lastAt,
        reason: s?.reason ?? "",
        hitCount: s?.hitCount ?? 0,
        blockCount: s?.blockCount ?? 0,
        firstAt: s?.firstAt ?? 0,
        lastAt: s?.lastAt ?? 0,
        expiresAt: s?.expiresAt ?? 0,
        blocked, // 与 isBlocked 口径一致：block_count>0 且未过期
        remainingMs: blocked ? s!.expiresAt - now : 0,
      };
    });
    return {
      code: 0,
      message: "success",
      data: { mode: "openid", openid, items, total: items.length },
    };
  }

  // ip → 该 IP 最近影响了哪些 openid
  const hits = await service.listHoneypotByIp(ip, limit);
  const [s] = await service.listStatusByIps([ip]);
  const blocked = !!s && s.blockCount > 0 && s.expiresAt > now;
  return {
    code: 0,
    message: "success",
    data: {
      mode: "ip",
      ip,
      items: hits.map((h) => ({
        openid: h.openid,
        honeypotHits: h.hits,
        honeypotLastAt: h.lastAt,
      })),
      total: hits.length,
      block: s
        ? {
            reason: s.reason,
            hitCount: s.hitCount,
            blockCount: s.blockCount,
            expiresAt: s.expiresAt,
            blocked,
            remainingMs: blocked ? s.expiresAt - now : 0,
          }
        : null,
    },
  };
});
