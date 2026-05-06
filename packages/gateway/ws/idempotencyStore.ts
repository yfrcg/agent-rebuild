
export type IdempotencyStatus = "running" | "completed" | "failed";

/** 单个幂等键对应的缓存记录。 */
export interface IdempotencyRecord {
  key: string;
  method: string;
  status: IdempotencyStatus;
  createdAt: number;
  updatedAt: number;
  payload?: unknown;
  error?: unknown;
}

/**
 * 进程内幂等记录存储。
 *
 * WS 网关的写操作和长任务可能因为网络抖动被客户端重发，
 * 这个存储用短 TTL 缓存请求结果，防止重复创建会话、重复写记忆或重复执行工具。
 */
export class IdempotencyStore {
  private readonly ttlMs: number;
  private readonly records = new Map<string, IdempotencyRecord>();

  /** 构造器说明：初始化当前类依赖和内部状态，保证实例创建后可以按既定生命周期工作。 */
  constructor(options?: { ttlMs?: number }) {
    this.ttlMs = options?.ttlMs ?? 10 * 60_000;
  }

  /** 读取幂等记录，读取前顺手清理过期数据。 */
  get(key: string): IdempotencyRecord | undefined {
    this.cleanup();
    return this.records.get(key);
  }

  /** 返回当前仍有效的幂等记录，主要供运行任务完成后反查请求使用。 */
  list(): IdempotencyRecord[] {
    this.cleanup();
    return Array.from(this.records.values());
  }

  /**
   * 开始记录一个幂等请求。
   *
   * 如果 key 已存在，直接返回旧记录，让调用方按旧状态响应。
   */
  begin(key: string, method: string, payload?: unknown): IdempotencyRecord {
    this.cleanup();
    const existing = this.records.get(key);
    if (existing) {
      return existing;
    }

    const now = Date.now();
    const record: IdempotencyRecord = {
      key,
      method,
      status: "running",
      createdAt: now,
      updatedAt: now,
      payload,
    };
    this.records.set(key, record);
    return record;
  }

  /** 将幂等请求标记为完成，并保存最终 payload。 */
  complete(key: string, payload: unknown): void {
    const record = this.records.get(key);
    if (!record) {
      return;
    }
    record.status = "completed";
    record.payload = payload;
    record.error = undefined;
    record.updatedAt = Date.now();
  }

  /** 将幂等请求标记为失败，后续同 key 请求会得到冲突响应。 */
  fail(key: string, error: unknown): void {
    const record = this.records.get(key);
    if (!record) {
      return;
    }
    record.status = "failed";
    record.error = error;
    record.updatedAt = Date.now();
  }

  /** 清理超过 TTL 的记录，避免长时间运行时 Map 无限增长。 */
  cleanup(): void {
    const now = Date.now();
    for (const [key, record] of this.records.entries()) {
      if (now - record.updatedAt > this.ttlMs) {
        this.records.delete(key);
      }
    }
  }
}
