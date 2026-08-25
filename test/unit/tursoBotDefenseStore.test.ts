/**
 * TursoBotDefenseStore 单元测试（2026-08-25 新增）
 *
 * 用 @libsql/client 的 file: 本地内存库（file::memory:）跑真实 SQL，
 * 验证 IP 黑名单分级封禁逻辑（2026-08-25 用户拍板）：
 * - block_count 1 → 24h，2 → 7 天，>=3 → 30 天
 * - block_count 跨周期保留：prune 只删"从未被正式拉黑过（block_count=0）"的
 *   过期条目，惯犯档案永久保留，解封后再刷从上一档继续升级
 * 不依赖线上 Turso（无网络、无凭据）。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TursoBotDefenseStore } from "../../server/core/services/tursoBotDefenseStore";

describe("TursoBotDefenseStore 分级封禁", () => {
  let store: TursoBotDefenseStore;

  beforeEach(async () => {
    store = new TursoBotDefenseStore("file::memory:");
    await (store as any).waitForInit();
  });

  afterEach(() => {
    store.close();
  });

  /** 直接查表拿 expires_at / block_count（绕过 isBlocked 的 >now 判断，精确验档位） */
  async function rowOf(ip: string) {
    const r = (
      await (store as any).client.execute(
        "SELECT expires_at, block_count FROM rejected_ips WHERE ip = ?",
        [ip]
      )
    ).rows[0];
    return r
      ? { expiresAt: r.expires_at as number, blockCount: r.block_count as number }
      : null;
  }

  it("首次拉黑：block_count=1，封禁 24h", async () => {
    const now = 1_700_000_000_000;
    const bc = await store.extendBlock("1.1.1.1", "bot_ua", now);
    expect(bc).toBe(1);

    const row = await rowOf("1.1.1.1");
    expect(row?.blockCount).toBe(1);
    expect(row?.expiresAt).toBe(now + 24 * 60 * 60_000);
  });

  it("再次拉黑升级：block_count=2，封禁 7 天", async () => {
    const now = 1_700_000_000_000;
    await store.extendBlock("2.2.2.2", "bot_ua", now);
    const bc = await store.extendBlock("2.2.2.2", "bot_ua", now + 8 * 24 * 60 * 60_000);
    expect(bc).toBe(2);

    const row = await rowOf("2.2.2.2");
    expect(row?.blockCount).toBe(2);
    expect(row?.expiresAt).toBe(now + 8 * 24 * 60 * 60_000 + 7 * 24 * 60 * 60_000);
  });

  it("三次及以上：block_count>=3，封禁 30 天封顶", async () => {
    const now = 1_700_000_000_000;
    const day = 24 * 60 * 60_000;
    await store.extendBlock("3.3.3.3", "bot_ua", now);
    await store.extendBlock("3.3.3.3", "bot_ua", now + 30 * day);
    const bc = await store.extendBlock("3.3.3.3", "bot_ua", now + 60 * day);
    expect(bc).toBe(3);

    const row = await rowOf("3.3.3.3");
    expect(row?.blockCount).toBe(3);
    expect(row?.expiresAt).toBe(now + 60 * day + 30 * day);
  });

  it("recordRejection 返回历史 block_count（惯犯识别）", async () => {
    const now = 1_700_000_000_000;
    await store.extendBlock("4.4.4.4", "bot_ua", now);
    const r = await store.recordRejection("4.4.4.4", "bot_ua", now + 25 * 60 * 60_000);
    expect(r.blockCount).toBe(1);
    expect(r.hitCount).toBe(1);
  });

  it("prune 只删从未拉黑过的过期条目，惯犯档案保留（跨周期继续升级）", async () => {
    const now = 1_700_000_000_000;
    const day = 24 * 60 * 60_000;

    // 惯犯：被拉黑过（block_count=1），expires 已过（40 天后）
    await store.extendBlock("recidivist", "bot_ua", now);
    // 非惯犯：只累计拒绝、从未达阈值（expires = now+1h 短过期，已过）
    await store.recordRejection("cleanup-me", "bot_ua", now - 2 * 60 * 60_000);

    const pruned = await store.pruneExpired(now + 40 * day);
    // 只清掉非惯犯
    expect(pruned).toBe(1);
    expect(await rowOf("recidivist")).not.toBeNull();
    expect(await rowOf("cleanup-me")).toBeNull();

    // 惯犯 40 天后再次达阈值：从第 2 档（7 天）继续，而不是从 1 重新来
    const bc = await store.extendBlock("recidivist", "bot_ua", now + 40 * day);
    expect(bc).toBe(2);
  });

  it("listEntries：返回条目含档位/时间字段，按最近活动倒序", async () => {
    const now = 1_700_000_000_000;
    const day = 24 * 60 * 60_000;
    // 封禁中的惯犯（block_count=2）
    await store.extendBlock("ban-a", "bot_ua", now - 1000);
    await store.extendBlock("ban-a", "bot_ua", now - 1000);
    // 短计数记录（未达阈值，block_count=0）
    await store.recordRejection("hit-b", "bad_term", now - 2000);

    const entries = await store.listEntries(now, 100);
    expect(entries).toHaveLength(2);
    // 最近活动倒序：ban-a(last_at=now-1000) 在 hit-b(last_at=now-2000) 前
    expect(entries[0].ip).toBe("ban-a");
    expect(entries[0].blockCount).toBe(2);
    expect(entries[0].expiresAt).toBe(now - 1000 + 7 * day);
    expect(entries[0].hitCount).toBe(0);
    expect(entries[1].ip).toBe("hit-b");
    expect(entries[1].blockCount).toBe(0);
  });

  it("manuallyBlock：管理页手动拉黑直接 30 天（block_count 从 0 跳到 3）", async () => {
    const now = 1_700_000_000_000;
    const day = 24 * 60 * 60_000;
    const bc = await store.manuallyBlock("5.5.5.5", "manual", now);

    expect(bc).toBe(3); // 手动拉黑固定取最长档
    const row = await rowOf("5.5.5.5");
    expect(row?.blockCount).toBe(3);
    expect(row?.expiresAt).toBe(now + 30 * day);
  });

  it("manuallyBlock：已有惯犯档案时在历史档位基础上 +1 且至少 3 档", async () => {
    const now = 1_700_000_000_000;
    const day = 24 * 60 * 60_000;
    // 先自动拉黑过一次（block_count=2，7 天档）
    await store.extendBlock("recidivist-m", "bot_ua", now);
    await store.extendBlock("recidivist-m", "bot_ua", now + 8 * day);

    const bc = await store.manuallyBlock("recidivist-m", "manual", now + 9 * day);
    expect(bc).toBe(3); // 2+1 → 3 档（30 天）
    const row = await rowOf("recidivist-m");
    expect(row?.expiresAt).toBe(now + 9 * day + 30 * day);
  });

  it("removeBlock：删除整行（含惯犯档案），返回是否删除", async () => {
    const now = 1_700_000_000_000;
    await store.extendBlock("doomed", "bot_ua", now);
    expect(await rowOf("doomed")).not.toBeNull();

    expect(await store.removeBlock("doomed")).toBe(true);
    expect(await rowOf("doomed")).toBeNull();
    // 已删除再删 → false
    expect(await store.removeBlock("doomed")).toBe(false);
  });

  it("removeBlock：删除从未拉黑的计数记录同样生效", async () => {
    const now = 1_700_000_000_000;
    await store.recordRejection("soft-rm", "rate_limit", now);
    expect(await store.removeBlock("soft-rm")).toBe(true);
    expect(await rowOf("soft-rm")).toBeNull();
  });

  it("第四次升级 → block_count=4，封禁时长变为永久（2026-08-25 用户拍板）", async () => {
    const now = 1_700_000_000_000;
    const day = 24 * 60 * 60_000;
    // 前三次按 24h/7d/30d 递增
    await store.extendBlock("perm-a", "bot_ua", now);
    await store.extendBlock("perm-a", "bot_ua", now + 1 * day);
    await store.extendBlock("perm-a", "bot_ua", now + 8 * day);
    const bc = await store.extendBlock("perm-a", "bot_ua", now + 38 * day);
    expect(bc).toBe(4);

    const row = await rowOf("perm-a");
    expect(row?.blockCount).toBe(4);
    // 永久 = far-future 时间戳（2100 年）
    expect(row?.expiresAt).toBe(4_100_000_000_000);
  });

  it("manuallyBlock 已查封 >=4 次历史 → 永久（2026-08-25）", async () => {
    const now = 1_700_000_000_000;
    const day = 24 * 60 * 60_000;
    // 先自动升级到 block_count=4（永久档）
    await store.extendBlock("manual-perm", "bot_ua", now);
    await store.extendBlock("manual-perm", "bot_ua", now + 1 * day);
    await store.extendBlock("manual-perm", "bot_ua", now + 8 * day);
    await store.extendBlock("manual-perm", "bot_ua", now + 38 * day);
    // 管理员再手动拉黑 → 仍是永久
    const bc = await store.manuallyBlock("manual-perm", "manual", now + 39 * day);
    expect(bc).toBeGreaterThanOrEqual(4);
    const row = await rowOf("manual-perm");
    expect(row?.expiresAt).toBe(4_100_000_000_000);
  });

  it("并发 recordRejection 不撞 UNIQUE 且 hit_count 正确累加（2026-08-26 修复回归）", async () => {
    // 复现线上 bug：同一 IP 短时间内多次频控命中，每次异步调 recordRejection
    // 原两段式 SELECT-then-INSERT 在并发下 TOCTOU，多个请求各自 SELECT 都没查到
    // 后都 INSERT，撞 PRIMARY KEY UNIQUE。原子 upsert 后应安全。
    const now = 1_700_000_000_000;
    const ip = "203.0.113.7";
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.recordRejection(ip, "rate_limit", now + i)
      )
    );
    // 无一抛 UNIQUE 错（到这步说明全成功）
    const hitCounts = results.map((r) => r.hitCount).sort((a, b) => a - b);
    expect(hitCounts).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    // 最终 hit_count == N
    const row = await rowOf(ip);
    expect(row?.blockCount).toBe(0); // 仅累计，未达拉黑阈值不会被 extendBlock
    const r2 = (
      await (store as any).client.execute(
        "SELECT hit_count FROM rejected_ips WHERE ip = ?",
        [ip]
      )
    ).rows[0];
    expect(r2?.hit_count as number).toBe(N);
  });

  it("recordRejection 对已拉黑条目：hit_count 在 extendBlock 的 0 基础上累加，block_count 不被覆盖", async () => {
    // extendBlock 插入时 hit_count=0, block_count=1；后续 recordRejection 走
    // ON CONFLICT 更新分支：hit_count=0+1=1，block_count 保留=1
    const now = 1_700_000_000_000;
    await store.extendBlock("9.9.9.9", "bot_ua", now);
    const r = await store.recordRejection("9.9.9.9", "bot_ua", now + 25 * 60 * 60_000);
    expect(r.hitCount).toBe(1);
    expect(r.blockCount).toBe(1);
    // 仍未被 extendBlock 改过 expires_at（保留拉黑时的 now+24h，已过期）
    expect(r.blocked).toBe(false); // block_count>0 但 expires_at(now+24h) <= now+25h
  });
});
