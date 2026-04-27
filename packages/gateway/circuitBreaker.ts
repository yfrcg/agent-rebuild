export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitCheckResult {
  allowed: boolean;
  state: CircuitState;
  retryAfterMs: number;
}

export interface GatewayCircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
}

export class GatewayCircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;

  constructor(private readonly options: GatewayCircuitBreakerOptions) {}

  beforeRequest(now = Date.now()): CircuitCheckResult {
    if (this.state === "open") {
      const elapsed = now - this.openedAt;
      if (elapsed >= this.options.cooldownMs) {
        this.state = "half-open";
        return {
          allowed: true,
          state: this.state,
          retryAfterMs: 0,
        };
      }

      return {
        allowed: false,
        state: this.state,
        retryAfterMs: Math.max(0, this.options.cooldownMs - elapsed),
      };
    }

    return {
      allowed: true,
      state: this.state,
      retryAfterMs: 0,
    };
  }

  onSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = "closed";
  }

  onFailure(now = Date.now()): void {
    this.consecutiveFailures += 1;

    if (this.consecutiveFailures >= this.options.failureThreshold) {
      this.state = "open";
      this.openedAt = now;
    }
  }

  getState(now = Date.now()): CircuitState {
    const probe = this.beforeRequest(now);
    return probe.state;
  }
}
