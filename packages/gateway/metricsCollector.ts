
import type { CircuitState } from "./circuitBreaker";

/**
 * 单次请求进入指标系统时的记录结构。
 */
export interface GatewayMetricsRecord {
  durationMs: number;
  hasError: boolean;
  rateLimited?: boolean;
  circuitOpen?: boolean;
  tokens?: { prompt: number; completion: number; total: number };
  costCents?: number;
  toolCallCount?: number;
  toolRetryCount?: number;
}

/**
 * 对外暴露的指标快照。
 *
 * 它既包含吞吐与错误率，也包含延迟分布和 SLO 判断结果，
 * 便于 CLI 或未来监控面板直接展示。
 */
export interface GatewayMetricsSnapshot {
  totalRequests: number;
  errorRequests: number;
  errorRate: number;
  avgDurationMs: number;
  p95DurationMs: number;
  rateLimitedRequests: number;
  circuitOpenRequests: number;
  circuitState: CircuitState;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalCostCents: number;
  totalToolCalls: number;
  totalToolRetries: number;
  avgToolCallsPerRequest: number;
  slo: {
    maxRtMs: number;
    maxErrorRate: number;
    rtOk: boolean;
    errorRateOk: boolean;
  };
}

export interface GatewayMetricsCollectorOptions {
  maxRtMs: number;
  maxErrorRate: number;
  historySize?: number;
}

/**
 * 轻量级运行时指标采集器。
 *
 * 它使用内存数组维护最近一段延迟历史，
 * 用最小成本为 Gateway 提供平均响应时间、P95、错误率和 SLO 评估。
 */
export class GatewayMetricsCollector {
  private readonly durations: number[] = [];
  private totalRequests = 0;
  private errorRequests = 0;
  private rateLimitedRequests = 0;
  private circuitOpenRequests = 0;
  private totalPromptTokens = 0;
  private totalCompletionTokens = 0;
  private totalTokens = 0;
  private totalCostCents = 0;
  private totalToolCalls = 0;
  private totalToolRetries = 0;

  /** 构造器说明：初始化当前类依赖和内部状态，保证实例创建后可以按既定生命周期工作。 */
  constructor(private readonly options: GatewayMetricsCollectorOptions) {}

  /**
   * 写入一条请求指标，并返回更新后的快照。
   *
   * 这里会同步更新计数器与延迟历史，
   * 然后立即生成一份最新快照，方便调用方直接使用。
   */
  record(record: GatewayMetricsRecord): GatewayMetricsSnapshot {
    this.totalRequests += 1;

    if (record.hasError) {
      this.errorRequests += 1;
    }

    if (record.rateLimited) {
      this.rateLimitedRequests += 1;
    }

    if (record.circuitOpen) {
      this.circuitOpenRequests += 1;
    }

    if (record.tokens) {
      this.totalPromptTokens += record.tokens.prompt;
      this.totalCompletionTokens += record.tokens.completion;
      this.totalTokens += record.tokens.total;
    }
    if (record.costCents) {
      this.totalCostCents += record.costCents;
    }
    if (record.toolCallCount) {
      this.totalToolCalls += record.toolCallCount;
    }
    if (record.toolRetryCount) {
      this.totalToolRetries += record.toolRetryCount;
    }

    this.durations.push(record.durationMs);

    // 限制历史窗口，避免长时间运行后内存持续增长。
    const historySize = this.options.historySize ?? 500;
    if (this.durations.length > historySize) {
      this.durations.splice(0, this.durations.length - historySize);
    }

    return this.snapshot("closed");
  }

  /**
   * 基于当前累计数据生成一份指标快照。
   *
   * P95 通过对历史延迟排序后取 95 分位点，
   * 用来近似描述“绝大多数请求”的用户体验。
   */
  snapshot(circuitState: CircuitState): GatewayMetricsSnapshot {
    const sorted = [...this.durations].sort((a, b) => a - b);
    const avgDurationMs =
      sorted.length === 0
        ? 0
        : sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
    const p95DurationMs =
      sorted.length === 0
        ? 0
        : sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
    const errorRate =
      this.totalRequests === 0 ? 0 : (this.errorRequests / this.totalRequests) * 100;

    return {
      totalRequests: this.totalRequests,
      errorRequests: this.errorRequests,
      errorRate: round(errorRate),
      avgDurationMs: round(avgDurationMs),
      p95DurationMs: round(p95DurationMs),
      rateLimitedRequests: this.rateLimitedRequests,
      circuitOpenRequests: this.circuitOpenRequests,
      circuitState,
      totalPromptTokens: this.totalPromptTokens,
      totalCompletionTokens: this.totalCompletionTokens,
      totalTokens: this.totalTokens,
      totalCostCents: round(this.totalCostCents),
      totalToolCalls: this.totalToolCalls,
      totalToolRetries: this.totalToolRetries,
      avgToolCallsPerRequest: this.totalRequests === 0 ? 0 : round(this.totalToolCalls / this.totalRequests),
      slo: {
        maxRtMs: this.options.maxRtMs,
        maxErrorRate: this.options.maxErrorRate,
        rtOk: p95DurationMs <= this.options.maxRtMs,
        errorRateOk: errorRate <= this.options.maxErrorRate,
      },
    };
  }
}

/**
 * 把浮点数统一保留两位小数。
 *
 * 指标展示更关心可读性，没必要保留过长的小数尾巴。
 */
function round(value: number): number {
  return Number(value.toFixed(2));
}
