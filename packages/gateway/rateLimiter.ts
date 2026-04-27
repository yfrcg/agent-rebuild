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

export class GatewayRateLimiter {
  private readonly requests = new Map<string, number[]>();

  constructor(private readonly options: GatewayRateLimiterOptions) {}

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
