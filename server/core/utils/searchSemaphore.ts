/**
 * 全局搜索并发信号量（进程级单例）
 *
 * 第一性原理：per-IP 限流只能防单点攻击，防不了多 IP 分布式打爆
 * （每个搜索请求会扇出几十~上千个上游请求）。全局信号量限制
 * "同时进行中的搜索请求总数"，超限立即 503 快速失败：
 * - 不排队：避免新请求在队列里等待，保证"搜索尽快展示"（失败即响应，用户可重试）
 * - 不误伤已开始的请求：已获取到槽位的搜索按原并发速度执行
 * - 可配置：SEARCH_MAX_CONCURRENCY 环境变量（默认 6）
 */
const DEFAULT_MAX_CONCURRENT_SEARCHES = 6;

class SearchSemaphore {
  private max: number;
  private count: number;

  constructor(max: number) {
    this.max = max;
    this.count = max;
  }

  /** 尝试获取一个槽位；无剩余立即返回 false（不等待） */
  tryAcquire(): boolean {
    if (this.count <= 0) return false;
    this.count--;
    return true;
  }

  release(): void {
    if (this.count < this.max) this.count++;
  }

  get available(): number {
    return this.count;
  }

  get limit(): number {
    return this.max;
  }
}

function resolveMax(): number {
  const raw = Number(process.env.SEARCH_MAX_CONCURRENCY);
  if (Number.isFinite(raw) && raw >= 1 && raw <= 64) return Math.floor(raw);
  return DEFAULT_MAX_CONCURRENT_SEARCHES;
}

const semaphore = new SearchSemaphore(resolveMax());

export function getSearchSemaphore(): SearchSemaphore {
  return semaphore;
}
