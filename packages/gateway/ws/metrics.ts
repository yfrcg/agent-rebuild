
export interface GatewayWsMetricsSnapshot {
  activeConnections: number;
  totalConnections: number;
  messagesReceived: number;
  messagesSent: number;
  eventsSent: number;
  runsStarted: number;
  runsCompleted: number;
  runsFailed: number;
  runsCancelled: number;
  authFailures: number;
  rateLimited: number;
  avgRunDurationMs: number;
  p95RunDurationMs: number;
}

/**
 * 轻量级进程内指标收集器。
 *
 * 当前实现不依赖外部监控系统，只在内存里累计计数和最近运行耗时；
 * 后续如果接入 Prometheus 或 OpenTelemetry，可以从这里替换输出层。
 */
export class GatewayWsMetricsCollector {
  private activeConnections = 0;
  private totalConnections = 0;
  private messagesReceived = 0;
  private messagesSent = 0;
  private eventsSent = 0;
  private runsStarted = 0;
  private runsCompleted = 0;
  private runsFailed = 0;
  private runsCancelled = 0;
  private authFailures = 0;
  private rateLimited = 0;
  private readonly runDurations: number[] = [];

  /** 记录新连接建立。 */
  connectionOpened(): void {
    this.activeConnections += 1;
    this.totalConnections += 1;
  }

  /** 记录连接关闭，计数不会降到负数。 */
  connectionClosed(): void {
    this.activeConnections = Math.max(0, this.activeConnections - 1);
  }

  /** 记录收到客户端消息。 */
  messageReceived(): void {
    this.messagesReceived += 1;
  }

  /** 记录向客户端发送消息。 */
  messageSent(): void {
    this.messagesSent += 1;
  }

  /** 记录事件发送；事件本身也是一条 WS 消息。 */
  eventSent(): void {
    this.eventsSent += 1;
    this.messageSent();
  }

  /** 记录聊天运行任务开始。 */
  runStarted(): void {
    this.runsStarted += 1;
  }

  /** 记录聊天运行任务成功完成。 */
  runCompleted(durationMs?: number): void {
    this.runsCompleted += 1;
    this.recordRunDuration(durationMs);
  }

  /** 记录聊天运行任务失败。 */
  runFailed(durationMs?: number): void {
    this.runsFailed += 1;
    this.recordRunDuration(durationMs);
  }

  /** 记录聊天运行任务取消。 */
  runCancelled(durationMs?: number): void {
    this.runsCancelled += 1;
    this.recordRunDuration(durationMs);
  }

  /** 记录一次鉴权失败。 */
  authFailure(): void {
    this.authFailures += 1;
  }

  /** 记录一次限流或并发上限拒绝。 */
  rateLimitedRequest(): void {
    this.rateLimited += 1;
  }

  /** 生成当前指标快照，并计算平均耗时和 p95 耗时。 */
  snapshot(): GatewayWsMetricsSnapshot {
    const sorted = [...this.runDurations].sort((a, b) => a - b);
    const avg =
      sorted.length === 0 ? 0 : sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
    const p95 =
      sorted.length === 0
        ? 0
        : sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
    return {
      activeConnections: this.activeConnections,
      totalConnections: this.totalConnections,
      messagesReceived: this.messagesReceived,
      messagesSent: this.messagesSent,
      eventsSent: this.eventsSent,
      runsStarted: this.runsStarted,
      runsCompleted: this.runsCompleted,
      runsFailed: this.runsFailed,
      runsCancelled: this.runsCancelled,
      authFailures: this.authFailures,
      rateLimited: this.rateLimited,
      avgRunDurationMs: round(avg),
      p95RunDurationMs: round(p95),
    };
  }

  /** 保存最近运行耗时，限制数组长度防止常驻进程无限占用内存。 */
  private recordRunDuration(durationMs: number | undefined): void {
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) {
      return;
    }
    this.runDurations.push(durationMs);
    if (this.runDurations.length > 500) {
      this.runDurations.splice(0, this.runDurations.length - 500);
    }
  }
}

/**
 * 函数 `round` 的职责说明。
 * `round` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function round(value: number): number {
  return Number(value.toFixed(2));
}
