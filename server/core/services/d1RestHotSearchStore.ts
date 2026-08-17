/**
 * D1 REST 适配器（Docker / 任意 Node 环境侧）
 *
 * 将 Cloudflare D1 REST API（POST /accounts/{id}/d1/database/{id}/query）
 * 包装成 D1DatabaseLike 接口，复用 D1HotSearchStore 实现——
 * 使 Docker 部署与 Cloudflare Worker 读写同一份热搜数据（D1 为唯一真源）。
 *
 * 配置（环境变量，缺失时 createD1RestHotSearchStore 抛错，由工厂回退 sqlite）：
 *   D1_ACCOUNT_ID    Cloudflare Account ID
 *   D1_DATABASE_ID   D1 数据库 ID
 *   D1_API_TOKEN     具 D1 Edit 权限的 API Token（Bearer）
 *
 * 注意：D1 REST 返回 rows 为二维数组（columns+rows），此处统一映射为对象数组；
 * batch 请求一次可携带多条 SQL，减少往返。
 */

import { D1HotSearchStore, type D1DatabaseLike, type D1PreparedStatementLike } from "./d1HotSearchStore";

const DEFAULT_BASE_URL = "https://api.cloudflare.com/client/v4";

export interface D1RestOptions {
  accountId?: string;
  databaseId?: string;
  apiToken?: string;
  baseUrl?: string;
  /** 可注入 fetch 实现（测试用） */
  fetchImpl?: typeof fetch;
}

interface D1RestQueryRequest {
  sql: string;
  params?: unknown[];
}

interface D1RestQueryResult {
  /** 行对象数组（键=列名），官方格式直接可用 */
  results?: any[];
  success?: boolean;
  meta?: { changes?: number; last_row_id?: number };
}

interface D1RestResponse {
  success: boolean;
  errors?: Array<{ message: string }>;
  result?: D1RestQueryResult[];
}

/** prepared 语句内部携带其 SQL/参数，供 batch 一次性取走 */
interface PreparedWithReq extends D1PreparedStatementLike {
  __req: () => D1RestQueryRequest;
}

export class D1RestDatabase implements D1DatabaseLike {
  private opts: Required<Pick<D1RestOptions, "accountId" | "databaseId" | "apiToken" | "baseUrl">> & {
    fetchImpl: typeof fetch;
  };

  constructor(options: D1RestOptions = {}) {
    const accountId = options.accountId ?? process.env.D1_ACCOUNT_ID;
    const databaseId = options.databaseId ?? process.env.D1_DATABASE_ID;
    const apiToken = options.apiToken ?? process.env.D1_API_TOKEN;
    if (!accountId || !databaseId || !apiToken) {
      throw new Error(
        "D1RestDatabase 配置缺失：需设置 D1_ACCOUNT_ID / D1_DATABASE_ID / D1_API_TOKEN"
      );
    }
    this.opts = {
      accountId,
      databaseId,
      apiToken,
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      fetchImpl: options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args)),
    };
  }

  /** 执行一批查询，返回每个查询对应的结果（对象数组 + meta） */
  private async runQuery(reqs: D1RestQueryRequest[]): Promise<D1RestQueryResult[]> {
    const { accountId, databaseId, apiToken, baseUrl, fetchImpl } = this.opts;
    const url = `${baseUrl}/accounts/${accountId}/d1/database/${databaseId}/query`;
    // 官方格式：单条 {sql, params}；多条 {batch: [{sql, params}, ...]}
    // （裸数组会报 "Expected object, received array"）
    const body = reqs.length === 1 ? reqs[0] : { batch: reqs };
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as D1RestResponse;
    if (!json.success) {
      const detail = json.errors?.map((e) => e.message).join("; ") ?? "unknown";
      throw new Error(`D1 REST 查询失败: ${detail}`);
    }
    return json.result ?? [];
  }

  /** D1 REST 响应 result[i].results 已是行对象数组（键=列名），直接透传 */
  private toObjects(meta: D1RestQueryResult): any[] {
    return meta?.results ?? [];
  }

  prepare(sql: string): D1PreparedStatementLike {
    const db = this;
    let params: unknown[] = [];
    const self: PreparedWithReq = {
      __req: () => ({ sql, params }),
      bind(...values: unknown[]): D1PreparedStatementLike {
        params = values;
        return self;
      },
      async all() {
        const [meta] = await db.runQuery([{ sql, params }]);
        return { results: db.toObjects(meta), success: true };
      },
      async first() {
        const [meta] = await db.runQuery([{ sql, params }]);
        return db.toObjects(meta)[0] ?? null;
      },
      async run() {
        await db.runQuery([{ sql, params }]);
        return { success: true };
      },
    };
    return self;
  }

  async batch(statements: D1PreparedStatementLike[]): Promise<any[]> {
    const reqs = (statements as PreparedWithReq[]).map((s) => s.__req());
    const metas = await this.runQuery(reqs);
    return metas;
  }

  /** 便捷方法：供外部（如启动自检）执行任意 SQL */
  async execSql(sql: string): Promise<{ success: boolean }> {
    await this.runQuery([{ sql }]);
    return { success: true };
  }

  exec(_sql: string): Promise<{ success: boolean }> {
    // 与 D1HotSearchStore 的 init 契约兼容：init 实际使用 batch，exec 置空实现
    return Promise.resolve({ success: true });
  }
}

/**
 * 创建 Docker 侧 D1 热搜存储（复用 D1HotSearchStore 全部 SQL 逻辑）
 * 配置缺失时抛错（工厂层捕获后回退 sqlite）
 */
export function createD1RestHotSearchStore(options: D1RestOptions = {}): D1HotSearchStore {
  const db = new D1RestDatabase(options);
  return new D1HotSearchStore(db as D1DatabaseLike);
}
