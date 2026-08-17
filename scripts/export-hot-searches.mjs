#!/usr/bin/env node
/**
 * 热搜数据导出脚本：本地 sqlite → SQL 文件（供 wrangler d1 execute 灌入 D1）
 *
 * 用法：
 *   node scripts/export-hot-searches.mjs                  # 默认读 ./data/hot-searches.db，输出 ./data/d1-hot-searches.sql
 *   node scripts/export-hot-searches.mjs --db <path>       # 指定源 db
 *   node scripts/export-hot-searches.mjs --out <path>      # 指定输出 SQL 路径
 *
 * 灌入 D1（需已 wrangler login）：
 *   wrangler d1 execute <database-name> --remote --file=./data/d1-hot-searches.sql
 *
 * 说明：D1 与本地 sqlite 同为 SQLite 语法，INSERT OR IGNORE 幂等，可重复执行。
 */
import { createRequire } from "node:module";
import { existsSync, writeFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const sqliteModule = () => require("node:" + "sqlite");

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
};
const DB_PATH = getArg("--db", process.env.HOT_SEARCH_DB_PATH || "./data/hot-searches.db");
const OUT_PATH = getArg("--out", "./data/d1-hot-searches.sql");

if (!existsSync(DB_PATH)) {
  console.error(`❌ 源数据库不存在: ${DB_PATH}`);
  process.exit(1);
}

const { DatabaseSync } = sqliteModule();
const db = new DatabaseSync(DB_PATH);

function dumpTable(name) {
  const cols = db.prepare(`SELECT * FROM ${name} LIMIT 0`).columns();
  const rows = db.prepare(`SELECT * FROM ${name}`).all();
  const colList = cols.map((c) => c.name).join(", ");
  const stmts = rows.map((row) => {
    const vals = cols
      .map((c) => {
        const v = row[c.name];
        if (v === null || v === undefined) return "NULL";
        if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
        // 字符串转义：单引号翻倍
        return `'${String(v).replace(/'/g, "''")}'`;
      })
      .join(", ");
    return `INSERT OR IGNORE INTO ${name} (${colList}) VALUES (${vals});`;
  });
  return { stmts, count: rows.length };
}

const hot = dumpTable("hot_searches");
const terms = dumpTable("search_terms");

const lines = [
  "-- PanHub 热搜数据 D1 迁移导出（INSERT OR IGNORE，幂等可重复执行）",
  `-- 来源: ${DB_PATH}`,
  `-- 生成时间: ${new Date().toISOString()}`,
  "",
  "-- 表结构（与 sqliteHotSearchStore / D1HotSearchStore 保持一致）",
  "CREATE TABLE IF NOT EXISTS hot_searches (",
  "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
  "  term TEXT NOT NULL UNIQUE,",
  "  score INTEGER NOT NULL DEFAULT 1,",
  "  last_searched_at INTEGER NOT NULL,",
  "  created_at INTEGER NOT NULL",
  ");",
  "CREATE INDEX IF NOT EXISTS idx_score ON hot_searches(score DESC);",
  "CREATE INDEX IF NOT EXISTS idx_last_searched ON hot_searches(last_searched_at DESC);",
  "CREATE TABLE IF NOT EXISTS search_terms (",
  "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
  "  term TEXT NOT NULL UNIQUE,",
  "  count INTEGER NOT NULL DEFAULT 1,",
  "  first_at INTEGER NOT NULL,",
  "  last_at INTEGER NOT NULL",
  ");",
  "CREATE INDEX IF NOT EXISTS idx_search_terms_last ON search_terms(last_at DESC);",
  "CREATE INDEX IF NOT EXISTS idx_search_terms_count ON search_terms(count DESC);",
  "",
  `-- hot_searches: ${hot.count} 条`,
  ...hot.stmts,
  "",
  `-- search_terms: ${terms.count} 条`,
  ...terms.stmts,
  "",
];

writeFileSync(OUT_PATH, lines.join("\n"), "utf-8");
db.close();

console.log(`✅ 导出完成: ${OUT_PATH}`);
console.log(`   hot_searches: ${hot.count} 条`);
console.log(`   search_terms: ${terms.count} 条`);
console.log("");
console.log("下一步（需 wrangler login）:");
console.log(`   wrangler d1 execute <database-name> --remote --file=${OUT_PATH}`);
