
import { randomUUID } from "node:crypto";

/** WS 聊天运行任务的状态。 */
export type RunStatus = "running" | "completed" | "failed" | "cancelled";

/**
 * 单次 `chat.send` 对应的运行任务记录。
 *
 * `abortController` 是取消能力的核心，路由层调用 `chat.cancel` 后会触发它，
 * Gateway 主处理链路再通过 signal 终止模型请求或工具循环。
 */
export interface GatewayRun {
  runId: string;
  sessionId: string;
  requestId: string;
  clientId?: string;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  abortController: AbortController;
  error?: string;
}

/**
 * 管理 WS 网关中的异步运行任务。
 *
 * 它只保存进程内状态，不承担持久化职责；断线恢复依赖事件回放和会话记录，
 * 正在运行的任务则由这里提供查询、计数、完成、失败和取消操作。
 */
export class RunManager {
  private readonly runs = new Map<string, GatewayRun>();

  /** 创建一条新的运行记录，并分配可广播给客户端的 runId。 */
  createRun(input: { sessionId: string; requestId: string; clientId?: string }): GatewayRun {
    const run: GatewayRun = {
      runId: `run_${randomUUID()}`,
      sessionId: input.sessionId,
      requestId: input.requestId,
      clientId: input.clientId,
      status: "running",
      startedAt: new Date().toISOString(),
      abortController: new AbortController(),
    };
    this.runs.set(run.runId, run);
    return run;
  }

  /** 读取指定运行任务。 */
  getRun(runId: string): GatewayRun | undefined {
    return this.runs.get(runId);
  }

  /** 将运行任务标记为成功完成。 */
  finishRun(runId: string): GatewayRun | undefined {
    return this.updateRun(runId, "completed");
  }

  /** 将运行任务标记为失败，并保存错误文本。 */
  failRun(runId: string, error: string): GatewayRun | undefined {
    return this.updateRun(runId, "failed", error);
  }

  /** 取消运行任务，同时触发 AbortController。 */
  cancelRun(runId: string): GatewayRun | undefined {
    const run = this.updateRun(runId, "cancelled");
    run?.abortController.abort();
    return run;
  }

  /** 列出所有运行任务，可按会话过滤。 */
  listRuns(sessionId?: string): GatewayRun[] {
    const runs = Array.from(this.runs.values());
    return sessionId ? runs.filter((run) => run.sessionId === sessionId) : runs;
  }

  /** 统计运行中的任务数量，用于客户端级和全局并发限制。 */
  countRunning(input?: { sessionId?: string; clientId?: string }): number {
    return this.listRuns(input?.sessionId).filter((run) => {
      if (run.status !== "running") {
        return false;
      }
      if (input?.clientId && run.clientId !== input.clientId) {
        return false;
      }
      return true;
    }).length;
  }

  /**
   * 统一推进运行状态。
   *
   * 已经结束的任务不会再次被改写，避免取消、失败、完成事件乱序时覆盖最终状态。
   */
  private updateRun(
    runId: string,
    status: RunStatus,
    error?: string
  ): GatewayRun | undefined {
    const run = this.runs.get(runId);
    if (!run) {
      return undefined;
    }
    if (run.status !== "running") {
      return run;
    }
    run.status = status;
    run.endedAt = new Date().toISOString();
    run.error = error;
    return run;
  }
}
