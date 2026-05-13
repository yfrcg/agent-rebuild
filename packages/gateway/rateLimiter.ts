/**
 * ?????CS336 ???
 * ???packages/gateway/rateLimiter.ts
 * ???Gateway ?????
 * ??????? Agent ?????????????????????
 * ???????????????????????????????????? README ????????????????
 */

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterMs: number;
  remaining: number;
  limit: number;
  windowMs: number;
}

export interface GatewayRateLimiterOptions {
  maxRequests: number;
  windowMs: number;
}

/**
 * 基于滑动时间窗口的轻量级限流器。
 *
 * 每个 key 对应一组请求时间戳：
 * - 先剔除窗口外的旧记录。
 * - 再判断窗口内请求数是否超过阈值。
 * 这种实现直观、易调试，适合 CLI 和单进程 Gateway 场景。
 */
export class GatewayRateLimiter {
  private readonly requests = new Map<string, number[]>();

  /** 构造器说明：初始化当前类依赖和内部状态，保证实例创建后可以按既定生命周期工作。 */
  constructor(private readonly options: GatewayRateLimiterOptions) {}

  /**
   * 检查某个 key 当前是否还允许继续请求。
   *
   * 如果允许，会顺手把本次请求时间记进去；
   * 如果不允许，则返回还需要等待多久才能重试。
   */
  check(key: string, now = Date.now()): RateLimitDecision {
    const recent = this.prune(key, now);

    if (recent.length >= this.options.maxRequests) {
      const oldest = recent[0] ?? now;
      return {
        allowed: false,
        retryAfterMs: Math.max(0, oldest + this.options.windowMs - now),
        remaining: 0,
        limit: this.options.maxRequests,
        windowMs: this.options.windowMs,
      };
    }

    recent.push(now);
    this.requests.set(key, recent);

    return {
      allowed: true,
      retryAfterMs: 0,
      remaining: Math.max(0, this.options.maxRequests - recent.length),
      limit: this.options.maxRequests,
      windowMs: this.options.windowMs,
    };
  }

  /**
   * 清理掉滑动窗口之外的旧时间戳。
   *
   * 这一步是限流准确性的核心，否则时间戳只增不减，所有 key 最终都会被永久限死。
   */
  private prune(key: string, now: number): number[] {
    const cutoff = now - this.options.windowMs;
    const values = (this.requests.get(key) ?? []).filter((timestamp) => timestamp > cutoff);

    if (values.length === 0) {
      this.requests.delete(key);
      return [];
    }

    this.requests.set(key, values);
    return values;
  }
}
