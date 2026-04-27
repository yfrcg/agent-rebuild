import type { CircuitState } from "./circuitBreaker";

export interface GatewayMetricsRecord {
  durationMs: number;
  hasError: boolean;
  rateLimited?: boolean;
  circuitOpen?: boolean;
}

export interface GatewayMetricsSnapshot {
  totalRequests: number;
  errorRequests: number;
  errorRate: number;
  avgDurationMs: number;
  p95DurationMs: number;
  rateLimitedRequests: number;
  circuitOpenRequests: number;
  circuitState: CircuitState;
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

export class GatewayMetricsCollector {
  private readonly durations: number[] = [];
  private totalRequests = 0;
  private errorRequests = 0;
  private rateLimitedRequests = 0;
  private circuitOpenRequests = 0;

  constructor(private readonly options: GatewayMetricsCollectorOptions) {}

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

    this.durations.push(record.durationMs);

    const historySize = this.options.historySize ?? 500;
    if (this.durations.length > historySize) {
      this.durations.splice(0, this.durations.length - historySize);
    }

    return this.snapshot("closed");
  }

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
      slo: {
        maxRtMs: this.options.maxRtMs,
        maxErrorRate: this.options.maxErrorRate,
        rtOk: p95DurationMs <= this.options.maxRtMs,
        errorRateOk: errorRate <= this.options.maxErrorRate,
      },
    };
  }
}

function round(value: number): number {
  return Number(value.toFixed(2));
}
