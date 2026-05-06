
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

/**
 * 一个轻量级熔断器实现。
 *
 * 它的职责是保护 Gateway 不被持续失败的上游模型服务拖垮：
 * 当连续失败达到阈值时，直接短路后续请求；冷却时间过去后再放少量请求探测恢复情况。
 */
export class GatewayCircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;

  /** 构造器说明：初始化当前类依赖和内部状态，保证实例创建后可以按既定生命周期工作。 */
  constructor(private readonly options: GatewayCircuitBreakerOptions) {}

  /**
   * 在真正发请求之前判断当前是否允许通过。
   *
   * 如果熔断器处于 `open`，则根据冷却时间决定继续拒绝，
   * 还是切换为 `half-open` 允许一次试探请求。
   */
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

  /**
   * 记录一次成功调用。
   *
   * 一旦上游请求成功，就说明当前链路恢复正常，
   * 因此直接清空失败计数并关闭熔断状态。
   */
  onSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = "closed";
  }

  /**
   * 记录一次失败调用。
   *
   * 当连续失败次数达到阈值时，熔断器会立刻打开，
   * 后续请求改走快速失败，避免继续堆压上游。
   */
  onFailure(now = Date.now()): void {
    this.consecutiveFailures += 1;

    if (this.consecutiveFailures >= this.options.failureThreshold) {
      this.state = "open";
      this.openedAt = now;
    }
  }

  /**
   * 读取当前熔断状态。
   *
   * 这里复用了 `beforeRequest()` 的状态推进逻辑，
   * 保证“读取状态”和“真正请求前检查”看到的是同一套结果。
   */
  getState(now = Date.now()): CircuitState {
    const probe = this.beforeRequest(now);
    return probe.state;
  }
}
