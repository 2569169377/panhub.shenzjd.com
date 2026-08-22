#!/usr/bin/env node
/**
 * 一次性回填脚本：把 search_terms 历史数据按 last_at 日聚合 SUM(count)，
 * 写入 daily_stats（覆盖所有历史日期）。
 *
 * 设计动机（2026-08-22 用户拍板）：
 * 每日"今日搜索次数"无法从累计 count 精确反推"该日新增了多少次"——
 * 累计 SUM 等于总搜索次数（精确），但无法拆解每日。
 * 直接用 SEARCH(terms) 的 count 归因到 last_at 那天，SUM 守恒 = 总搜索次数，
 * 是一个能让"今日搜索次数 ≠ 0"且口径对用户可读的近似方案。
 *
 * 使用方式：
 *   node --env-file=.env scripts/backfill-daily-stats.mjs
 * 或：
 *   export $(cat .env | xargs) && node scripts/backfill-daily-stats.mjs
 *
 * 注意：定时任务不需要每日跑——新搜索写入时 store.flush 已自动调
 * recomputeDailySearches(today) 重算今日。该脚本只在 daily_stats 表首次
 * 建立 / 丢失后需要跑一次来灌入历史。
 */

import { createClient } from "@libsql/client";

const TURSO_URL = process.env.TURSO_URL;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;

if (!TURSO_URL) {
  console.error("[backfill-daily-stats] 未配置 TURSO_URL 环境变量，跳过");
  process.exit(1);
}
if (!TURSO_URL.startsWith("libsql:") && !TURSO_URL.startsWith("https:") && !TURSO_URL.startsWith("file:")) {
  console.error("[backfill-daily-stats] 仅支持 Turso/libSQL/file 数据库，跳过");
  process.exit(1);
}

const client = createClient({ url: TURSO_URL, authToken: TURSO_AUTH_TOKEN || undefined });

console.log("[backfill-daily-stats] 开始回填 daily_stats 表 ...");

try {
  // 确保表存在
  await client.batch([
    `CREATE TABLE IF NOT EXISTS search_terms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      term TEXT NOT NULL UNIQUE,
      count INTEGER NOT NULL DEFAULT 1,
      first_at INTEGER NOT NULL,
      last_at INTEGER NOT NULL
    )`,
    "CREATE INDEX IF NOT EXISTS idx_search_terms_last ON search_terms(last_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_search_terms_count ON search_terms(count DESC)",
    `CREATE TABLE IF NOT EXISTS daily_stats (
      date TEXT PRIMARY KEY,
      searches INTEGER NOT NULL DEFAULT 0
    )`,
  ]);

  // 按 last_at 北京时间日分组 SUM(count)
  const rows = (
    await client.execute(
      `SELECT date((last_at + 8*3600*1000) / 1000, 'unixepoch') as day, SUM(count) as s
       FROM search_terms
       WHERE last_at IS NOT NULL
       GROUP BY day`
    )
  ).rows;

  let written = 0;
  for (const r of rows) {
    const day = r.day;
    const sum = Number(r.s ?? 0);
    await client.execute(
      `INSERT INTO daily_stats (date, searches) VALUES (?, ?)
       ON CONFLICT(date) DO UPDATE SET searches = excluded.searches`,
      [day, sum]
    );
    written++;
  }
  console.log(`[backfill-daily-stats] 完成：写入 ${written} 个日期`);
} catch (err) {
  console.error("[backfill-daily-stats] 失败:", err instanceof Error ? err.message : err);
  process.exit(1);
} finally {
  client.close();
}
