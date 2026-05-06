
import * as fs from "node:fs";
import { randomBytes } from "node:crypto";

import type { Interface as ReadlineInterface } from "node:readline";

import type { AuditEventType } from "../audit/types";
import { resolveWorkspacePath } from "../core/src/config";
import { discoverSkills, selectSkillsForUserInput } from "../core/src/skills";
import type { TranscriptEntry } from "../core/src/types";

import {
  preCompactionFlush,
  postCompactionRecovery,
} from "../session/src/compaction";
import { compactTranscript } from "../session/src/compact";

import { classifyMemory } from "../memory/src/classifyMemory";
import {
  writeDailyMemory,
  writeLongTermMemory,
} from "../memory/src/memoryWriter";
import { hybridSearch } from "../memory/src/hybridSearch";
import { upsertFileIndex } from "../memory/src/memoryIndex";

import type { ParsedGatewayCommand } from "./commandParser";
import type { GatewayPlanApprovalMode, GatewayPlanState } from "./permissionTypes";
import { createApprovalToken } from "./approvalToken";
import { printGatewayHelp } from "./replHelp";
import { SessionManager } from "./sessionManager";
import type { GatewaySandbox } from "./sandbox";
import { GatewayMcpManager } from "./mcpManager";
import { createGatewayToolCallRequest } from "./toolCallFactory";
import { extractProjectBoundary } from "./sessionTypes";
import { ToolCallExecutor } from "./toolCallExecutor";
import { printToolCallRecord } from "./toolCallPrinter";
import { ToolRegistry } from "./toolRegistry";
import { recordTranscript } from "./transcriptRecorder";

/**
 * 内建命令处理器需要依赖的上下文对象。
 *
 * 之所以把依赖集中成一个对象传入，
 * 是为了让命令处理器更容易测试，也避免参数列表无限增长。
 */
export interface ReplCommandHandlerContext {
  sessionManager: SessionManager;
  toolRegistry: ToolRegistry;
  toolCallExecutor: ToolCallExecutor;
  memoryTopK: number;
  mcpManager?: GatewayMcpManager;
  sandbox: GatewaySandbox;
  auditLogger?: unknown;
  confirmTokenTtlMs: number;
  rl: ReadlineInterface;
}

/**
 * 命令处理结果。
 *
 * - `handled=true` 表示该输入已经在命令层完成处理，不要再走模型对话链路。
 * - `shouldExit=true` 表示主循环应终止。
 */
export interface ReplCommandHandleResult {
  handled: boolean;
  shouldExit?: boolean;
}

/**
 * 处理 REPL 层内建命令。
 *
 * 这里的职责是把 `parseGatewayCommand()` 产出的命令类型，进一步执行成具体动作，
 * 包括会话管理、记忆写入、MCP 状态查看、工具手动调用等。
 */
export async function handleBuiltInGatewayCommand(
  command: ParsedGatewayCommand,
  context: ReplCommandHandlerContext
): Promise<ReplCommandHandleResult> {
  /**
   * 把一条系统反馈记录到“当前会话”中。
   *
   * 这样即使命令没有走模型链路，用户仍然能在 transcript 里看到完整交互历史。
   */
  const recordToCurrentSession = (
    role: TranscriptEntry["role"],
    content: string
  ): void => {
    const sessionId = context.sessionManager.getCurrentSessionId();
    recordTranscript(sessionId, role, content);
    context.sessionManager.incrementCurrentSessionMessageCount();
  };

  /** 函数变量 `recordAudit`：保存可调用逻辑，调用方依赖它完成对应流程或测试夹具行为。 */
  const recordAudit = async (
    type: AuditEventType,
    message: string,
    data: Record<string, unknown> = {}
  ): Promise<void> => {
    if (!context.auditLogger) {
      return;
    }

    const logger = context.auditLogger as {
      log?: (event: unknown) => Promise<void> | void;
      record?: (event: unknown) => Promise<void> | void;
      append?: (event: unknown) => Promise<void> | void;
      write?: (event: unknown) => Promise<void> | void;
    };

    const event = {
      id: `${type}-${Date.now()}-${randomBytes(6).toString("hex")}`,
      requestId: `session:${context.sessionManager.getCurrentSessionId()}`,
      type,
      message,
      createdAt: new Date().toISOString(),
      data: {
        sessionId: context.sessionManager.getCurrentSessionId(),
        ...data,
      },
    };

    try {
      if (typeof logger.log === "function") {
        await logger.log(event);
        return;
      }
      if (typeof logger.record === "function") {
        await logger.record(event);
        return;
      }
      if (typeof logger.append === "function") {
        await logger.append(event);
        return;
      }
      if (typeof logger.write === "function") {
        await logger.write(event);
      }
    } catch {
      // 审计失败不能中断主流程。
    }
  };

  if (command.type === "exit") {
    console.log("Bye.");
    recordToCurrentSession("assistant", "Bye.");
    context.rl.close();

    return {
      handled: true,
      shouldExit: true,
    };
  }

  if (command.type === "help") {
    printGatewayHelp();
    recordToCurrentSession("assistant", "Displayed help menu.");

    return {
      handled: true,
    };
  }

  if (command.type === "mcp") {
    const manager = context.mcpManager;
    const payload = (command.payload ?? "").trim();

    if (!manager || !manager.hasConfiguredServers()) {
      const output = "No MCP servers configured. Create config/mcp.servers.json.";
      console.log(output);
      recordToCurrentSession("assistant", output);
      return {
        handled: true,
      };
    }

    // `:mcp` 和 `:mcp status` 都走状态查看。
    if (!payload || payload === "status") {
      const statuses = manager.listStatuses();
      console.log("[mcp] server status:");
      statuses.forEach((status, index) => {
        const base = `${index + 1}. ${status.id} (${status.name}) enabled=${status.enabled} connected=${status.connected} tools=${status.toolCount} phase=${status.phase ?? "unknown"} launch=${status.launchMode ?? "direct"} isolation=${status.isolationMode ?? "off"}`;
        if (status.error) {
          console.log(`${base} error=${status.error}`);
        } else {
          console.log(base);
        }
        if (status.runtimeRoot) {
          console.log(`   runtimeRoot=${status.runtimeRoot}`);
        }
        if (status.cwd) {
          console.log(`   cwd=${status.cwd}`);
        }
      });
      recordToCurrentSession("assistant", `[mcp] listed ${statuses.length} server status(es).`);
      return {
        handled: true,
      };
    }

    if (payload === "tools") {
      const tools = manager.listTools();
      if (tools.length === 0) {
        const output = "[mcp] no MCP tools discovered";
        console.log(output);
        recordToCurrentSession("assistant", output);
        return {
          handled: true,
        };
      }

      console.log("[mcp] discovered tools:");
      tools.forEach((tool, index) => {
        const description = tool.description ?? "(no description)";
        console.log(
          `${index + 1}. ${tool.gatewayToolName} <- ${tool.serverId}.${tool.originalName} - ${description}`
        );
      });
      recordToCurrentSession("assistant", `[mcp] listed ${tools.length} tool(s).`);
      return {
        handled: true,
      };
    }

    const output = "[mcp] usage: :mcp | :mcp status | :mcp tools";
    console.log(output);
    recordToCurrentSession("assistant", output);
    return {
      handled: true,
    };
  }

  if (command.type === "skills") {
    const payload = (command.payload ?? "").trim();
    const discovery = discoverSkills();

    if (discovery.skills.length === 0) {
      const output = "[skills] no compatible SKILL.md files discovered";
      console.log(output);
      recordToCurrentSession("assistant", output);
      return {
        handled: true,
      };
    }

    if (!payload || payload === "list") {
      console.log("[skills] discovered:");
      discovery.skills.forEach((skill, index) => {
        console.log(
          `${index + 1}. ${skill.name} [platform=${skill.platform}] ${skill.description}`
        );
      });
      recordToCurrentSession(
        "assistant",
        `[skills] listed ${discovery.skills.length} compatible skill(s).`
      );
      return {
        handled: true,
      };
    }

    if (payload === "current") {
      const currentSkills = context.sessionManager.getCurrentSession().activeSkills ?? [];
      const output =
        currentSkills.length === 0
          ? "[skills] no active session skills"
          : `[skills] active: ${currentSkills.join(", ")}`;
      console.log(output);
      recordToCurrentSession("assistant", output);
      return {
        handled: true,
      };
    }

    if (payload === "clear") {
      context.sessionManager.setCurrentSessionSkills([]);
      const output = "[skills] cleared active session skills";
      console.log(output);
      recordToCurrentSession("assistant", output);
      return {
        handled: true,
      };
    }

    if (payload === "use" || payload.startsWith("use ")) {
      const requestedName = payload.replace(/^use\s*/, "").trim();
      const matched = selectSkillsForUserInput(requestedName, discovery.skills, {
        maxMatches: 1,
      })[0];

      if (!matched) {
        const output = `[skills] not found: ${requestedName}`;
        console.log(output);
        recordToCurrentSession("assistant", output);
        return {
          handled: true,
        };
      }

      const current = context.sessionManager.getCurrentSession().activeSkills ?? [];
      const conflicts = discovery.skills
        .filter((skill) => skill.name === matched.name)
        .flatMap((skill) => skill.conflicts ?? []);
      const updated = [...new Set([...current.filter((name) => !conflicts.includes(name)), matched.name])];
      context.sessionManager.setCurrentSessionSkills(updated);
      const conflictNote =
        conflicts.length > 0
          ? ` (removed conflicts: ${current.filter((name) => conflicts.includes(name)).join(", ") || "none"})`
          : "";
      const output = `[skills] activated for session: ${matched.name}${conflictNote}`;
      console.log(output);
      recordToCurrentSession("assistant", output);
      return {
        handled: true,
      };
    }

    const requestedName = payload.replace(/^show\s*/, "").trim();
    const matched = selectSkillsForUserInput(requestedName, discovery.skills, {
      maxMatches: 1,
    })[0];

    if (!matched) {
      const output = `[skills] not found: ${requestedName}`;
      console.log(output);
      recordToCurrentSession("assistant", output);
      return {
        handled: true,
      };
    }

    console.log(`[skills] ${matched.name} (${matched.relativePath})`);
    console.log(matched.content);
    recordToCurrentSession("assistant", `[skills] showed ${matched.name}.`);
    return {
      handled: true,
    };
  }

  if (command.type === "plan") {
    const payload = (command.payload ?? "").trim();
    const currentSession = context.sessionManager.getCurrentSession();
    const currentPlan = currentSession.planState;

    if (!payload || payload === "show") {
      if (!currentPlan?.active) {
        const output = "[plan] inactive";
        console.log(output);
        recordToCurrentSession("assistant", output);
        return { handled: true };
      }

      console.log(
        `[plan] status=${currentPlan.status} mode=${currentSession.permissionMode ?? "default"}`
      );
      if (currentPlan.planPath) {
        console.log(`[plan] file=${currentPlan.planPath}`);
      }
      if (currentPlan.summary) {
        console.log(`[plan] summary=${currentPlan.summary}`);
      }
      if (currentPlan.content) {
        console.log(currentPlan.content);
      }
      recordToCurrentSession("assistant", `[plan] showed ${currentPlan.status} plan state.`);
      return { handled: true };
    }

    if (payload === "on") {
      const nextPlan = createPlanState(currentSession.id, currentPlan);
      persistPlanState(nextPlan);
      context.sessionManager.setCurrentSessionPermissionMode("plan");
      context.sessionManager.setCurrentSessionPlanState(nextPlan);
      const output = `[plan] enabled. Mode=plan. Write/shell tools are now blocked until approval. Plan file: ${nextPlan.planPath}`;
      console.log(output);
      recordToCurrentSession("assistant", output);
      return { handled: true };
    }

    if (payload === "off") {
      context.sessionManager.setCurrentSessionPermissionMode("default");
      if (currentPlan?.active) {
        const updatedPlan: GatewayPlanState = {
          ...currentPlan,
          active: false,
          updatedAt: new Date().toISOString(),
        };
        context.sessionManager.setCurrentSessionPlanState(updatedPlan);
      }
      const output = "[plan] disabled. Mode=default.";
      console.log(output);
      recordToCurrentSession("assistant", output);
      return { handled: true };
    }

    if (payload === "reject") {
      if (!currentPlan?.active) {
        const output = "[plan] no active plan to reject";
        console.log(output);
        recordToCurrentSession("assistant", output);
        return { handled: true };
      }

      const rejectedPlan: GatewayPlanState = {
        ...currentPlan,
        status: "rejected",
        active: false,
        approvalMode: "reject",
        updatedAt: new Date().toISOString(),
      };
      persistPlanState(rejectedPlan);
      context.sessionManager.setCurrentSessionPermissionMode("default");
      context.sessionManager.setCurrentSessionPlanState(rejectedPlan);
      const output = "[plan] rejected. Mode=default.";
      console.log(output);
      recordToCurrentSession("assistant", output);
      return { handled: true };
    }

    if (
      payload === "approve" ||
      payload === "execute_with_context" ||
      payload === "execute_fresh"
    ) {
      if (!currentPlan?.active) {
        const output = "[plan] no active plan to approve";
        console.log(output);
        recordToCurrentSession("assistant", output);
        return { handled: true };
      }

      const approvalMode = normalizePlanApprovalMode(payload);
      const approvedPlan: GatewayPlanState = {
        ...currentPlan,
        status: "approved",
        active: false,
        approvalMode,
        approvedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      persistPlanState(approvedPlan);
      context.sessionManager.setCurrentSessionPermissionMode("default");
      context.sessionManager.setCurrentSessionPlanState(approvedPlan);
      const output = `[plan] approved via ${approvalMode}. Mode=default. Submit the next request to execute.`;
      console.log(output);
      recordToCurrentSession("assistant", output);
      return { handled: true };
    }

    const output =
      "[plan] usage: :plan on | :plan off | :plan show | :plan approve | :plan reject | :plan execute_with_context | :plan execute_fresh";
    console.log(output);
    recordToCurrentSession("assistant", output);
    return { handled: true };
  }

  if (command.type === "confirm") {
    const token = (command.payload ?? "").trim();
    if (!token) {
      const output = "[confirm] usage: :confirm <token>";
      console.log(output);
      recordToCurrentSession("assistant", output);
      return {
        handled: true,
      };
    }

    const consumeResult = context.sessionManager.consumeCurrentSessionApproval(token);
    if (consumeResult.status !== "consumed" || !consumeResult.approval) {
      const output =
        consumeResult.status === "expired"
          ? `[confirm] token expired: ${token}`
          : `[confirm] token not found or already used: ${token}`;
      console.log(output);
      recordToCurrentSession("assistant", output);
      await recordAudit(
        consumeResult.status === "expired"
          ? "gateway.confirmation.expired"
          : "gateway.confirmation.missing",
        output,
        {
          token,
          toolName: consumeResult.approval?.toolName,
          createdAt: consumeResult.approval?.createdAt,
          expiresAt: consumeResult.approval?.expiresAt,
        }
      );
      return {
        handled: true,
      };
    }
    const approval = consumeResult.approval;

    await recordAudit(
      "gateway.confirmation.confirmed",
      `[confirm] token accepted for ${approval.toolName}`,
      {
        token: approval.token,
        toolName: approval.toolName,
        createdAt: approval.createdAt,
        expiresAt: approval.expiresAt,
      }
    );

    const toolCallRequest = createGatewayToolCallRequest({
      toolName: approval.toolName,
      input: approval.input,
      sessionId: context.sessionManager.getCurrentSessionId(),
      approved: true,
      permissionMode:
        context.sessionManager.getCurrentSession().permissionMode ?? "default",
      planState: context.sessionManager.getCurrentSession().planState,
      projectBoundary: extractProjectBoundary(context.sessionManager.getCurrentSession()),
    });
    const toolCallRecord = await context.toolCallExecutor.execute(toolCallRequest);
    printToolCallRecord(toolCallRecord);
    recordToCurrentSession(
      "assistant",
      `[tool-call] ${toolCallRecord.toolName} ${toolCallRecord.status} (${toolCallRecord.id})`
    );
    return {
      handled: true,
    };
  }

  if (command.type === "reject") {
    const token = (command.payload ?? "").trim();
    if (!token) {
      const output = "[reject] usage: :reject <token>";
      console.log(output);
      recordToCurrentSession("assistant", output);
      return {
        handled: true,
      };
    }

    const result = context.sessionManager.rejectCurrentSessionApproval(token);
    if (result.status !== "rejected" || !result.approval) {
      const output =
        result.status === "expired"
          ? `[reject] token already expired: ${token}`
          : `[reject] token not found: ${token}`;
      console.log(output);
      recordToCurrentSession("assistant", output);
      await recordAudit(
        result.status === "expired"
          ? "gateway.confirmation.expired"
          : "gateway.confirmation.missing",
        output,
        {
          token,
          toolName: result.approval?.toolName,
          createdAt: result.approval?.createdAt,
          expiresAt: result.approval?.expiresAt,
        }
      );
      return {
        handled: true,
      };
    }

    const output = `[reject] removed approval token for ${result.approval.toolName}: ${token}`;
    console.log(output);
    recordToCurrentSession("assistant", output);
    await recordAudit("gateway.confirmation.rejected", output, {
      token,
      toolName: result.approval.toolName,
      createdAt: result.approval.createdAt,
      expiresAt: result.approval.expiresAt,
    });
    return {
      handled: true,
    };
  }

  if (command.type === "approvals") {
    const payload = (command.payload ?? "").trim();
    if (payload === "clear") {
      const approvals = context.sessionManager.clearCurrentSessionApprovals();
      const output =
        approvals.length === 0
          ? "[approvals] nothing to clear"
          : `[approvals] cleared ${approvals.length} pending approval(s)`;
      console.log(output);
      recordToCurrentSession("assistant", output);
      if (approvals.length > 0) {
        await recordAudit("gateway.confirmation.cleared", output, {
          count: approvals.length,
          toolNames: approvals.map((item) => item.toolName),
          tokens: approvals.map((item) => item.token),
        });
      }
      return {
        handled: true,
      };
    }

    const approvals = context.sessionManager.listCurrentSessionApprovals();
    if (approvals.length === 0) {
      const output = "[approvals] no pending approvals";
      console.log(output);
      recordToCurrentSession("assistant", output);
      return {
        handled: true,
      };
    }

    console.log("[approvals] pending:");
    approvals.forEach((approval, index) => {
      console.log(
        `${index + 1}. token=${approval.token} tool=${approval.toolName} expiresAt=${approval.expiresAt}`
      );
      console.log(`   message=${approval.message}`);
    });
    recordToCurrentSession(
      "assistant",
      `[approvals] listed ${approvals.length} pending approval(s).`
    );
    return {
      handled: true,
    };
  }

  if (command.type === "tools") {
    const tools = context.toolRegistry.list();
    if (tools.length === 0) {
      const output = "[tools] no registered tools";
      console.log(output);
      recordToCurrentSession("assistant", output);
      return {
        handled: true,
      };
    }

    console.log("[tools] registered:");
    tools.forEach((tool, index) => {
      const policySuffix = tool.policy
        ? ` [automation=${tool.policy.automationLevel}, risk=${tool.policy.riskLevel}]`
        : "";
      console.log(`${index + 1}. ${tool.name} - ${tool.description}${policySuffix}`);
    });
    recordToCurrentSession("assistant", `[tools] listed ${tools.length} tool(s).`);
    return {
      handled: true,
    };
  }

  if (command.type === "tool") {
    const payload = (command.payload ?? "").trim();
    if (!payload) {
      const output = "[tool] usage: :tool <name> <json>";
      console.log(output);
      recordToCurrentSession("assistant", output);
      return {
        handled: true,
      };
    }

    // 约定命令第一段是工具名，剩余部分整体视为 JSON 输入。
    const firstSpace = payload.indexOf(" ");
    const toolName = firstSpace === -1 ? payload : payload.slice(0, firstSpace).trim();
    const jsonInput = firstSpace === -1 ? "" : payload.slice(firstSpace + 1).trim();

    if (!toolName) {
      const output = "[tool] missing tool name. usage: :tool <name> <json>";
      console.log(output);
      recordToCurrentSession("assistant", output);
      return {
        handled: true,
      };
    }

    if (!jsonInput) {
      const output = "[tool] missing json input. usage: :tool <name> <json>";
      console.log(output);
      recordToCurrentSession("assistant", output);
      return {
        handled: true,
      };
    }

    let parsedInput: Record<string, unknown>;
    try {
      const parsed = JSON.parse(jsonInput) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        const output = "[tool] json input must be an object";
        console.log(output);
        recordToCurrentSession("assistant", output);
        return {
          handled: true,
        };
      }
      parsedInput = parsed as Record<string, unknown>;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const output = `[tool] JSON parse failed: ${message}`;
      console.log(output);
      recordToCurrentSession("assistant", output);
      return {
        handled: true,
      };
    }

    const tool = context.toolRegistry.get(toolName);
    const pathDecision = context.sandbox.canUseToolInputPaths(parsedInput);
    if (!pathDecision.allowed) {
      console.log(pathDecision.reason);
      recordToCurrentSession("assistant", pathDecision.reason ?? "[sandbox] blocked tool path");
      return {
        handled: true,
      };
    }

    if (context.sandbox.requiresConfirmation(tool)) {
      const confirmMessage =
        tool?.policy?.confirmationMessage ??
        `[tool] ${toolName} requires confirmation due to its policy`;
      const token = createApprovalToken();
      const createdAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + context.confirmTokenTtlMs).toISOString();
      context.sessionManager.addCurrentSessionApproval({
        token,
        toolName,
        input: parsedInput,
        createdAt,
        expiresAt,
        message: confirmMessage,
      });
      const output = `[tool] confirmation required for ${toolName}. token=${token}. expiresAt=${expiresAt}. Run :confirm ${token}`;
      console.log(confirmMessage);
      console.log(output);
      recordToCurrentSession("assistant", output);
      await recordAudit("gateway.confirmation.queued", output, {
        token,
        toolName,
        createdAt,
        expiresAt,
        automationLevel: tool?.policy?.automationLevel,
        riskLevel: tool?.policy?.riskLevel,
      });
      return {
        handled: true,
      };
    }

    const toolCallRequest = createGatewayToolCallRequest({
      toolName,
      input: parsedInput,
      sessionId: context.sessionManager.getCurrentSessionId(),
      permissionMode:
        context.sessionManager.getCurrentSession().permissionMode ?? "default",
      planState: context.sessionManager.getCurrentSession().planState,
      projectBoundary: extractProjectBoundary(context.sessionManager.getCurrentSession()),
    });
    const toolCallRecord = await context.toolCallExecutor.execute(toolCallRequest);
    printToolCallRecord(toolCallRecord);
    recordToCurrentSession(
      "assistant",
      `[tool-call] ${toolCallRecord.toolName} ${toolCallRecord.status} (${toolCallRecord.id})`
    );
    return {
      handled: true,
    };
  }

  if (command.type === "sandbox" || command.type === "sh") {
    const payload = (command.payload ?? "").trim();
    if (!payload) {
      const output =
        command.type === "sh"
          ? "[sandbox] usage: :sh <command>"
          : "[sandbox] usage: :sandbox <command>";
      console.log(output);
      recordToCurrentSession("assistant", output);
      return {
        handled: true,
      };
    }

    const toolName = "bash.run";
    const toolInput: Record<string, unknown> = {
      command: payload,
    };
    const tool = context.toolRegistry.get(toolName);
    const pathDecision = context.sandbox.canUseToolInputPaths(toolInput);
    if (!pathDecision.allowed) {
      console.log(pathDecision.reason);
      recordToCurrentSession("assistant", pathDecision.reason ?? "[sandbox] blocked tool path");
      return {
        handled: true,
      };
    }

    if (context.sandbox.requiresConfirmation(tool)) {
      const confirmMessage =
        tool?.policy?.confirmationMessage ??
        `[tool] ${toolName} requires confirmation due to its policy`;
      const token = createApprovalToken();
      const createdAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + context.confirmTokenTtlMs).toISOString();
      context.sessionManager.addCurrentSessionApproval({
        token,
        toolName,
        input: toolInput,
        createdAt,
        expiresAt,
        message: confirmMessage,
      });
      const output = `[tool] confirmation required for ${toolName}. token=${token}. expiresAt=${expiresAt}. Run :confirm ${token}`;
      console.log(confirmMessage);
      console.log(output);
      recordToCurrentSession("assistant", output);
      await recordAudit("gateway.confirmation.queued", output, {
        token,
        toolName,
        createdAt,
        expiresAt,
        automationLevel: tool?.policy?.automationLevel,
        riskLevel: tool?.policy?.riskLevel,
      });
      return {
        handled: true,
      };
    }

    const toolCallRequest = createGatewayToolCallRequest({
      toolName,
      input: toolInput,
      sessionId: context.sessionManager.getCurrentSessionId(),
      permissionMode:
        context.sessionManager.getCurrentSession().permissionMode ?? "default",
      planState: context.sessionManager.getCurrentSession().planState,
      projectBoundary: extractProjectBoundary(context.sessionManager.getCurrentSession()),
    });
    const toolCallRecord = await context.toolCallExecutor.execute(toolCallRequest);
    printToolCallRecord(toolCallRecord);
    recordToCurrentSession(
      "assistant",
      `[tool-call] ${toolCallRecord.toolName} ${toolCallRecord.status} (${toolCallRecord.id})`
    );
    return {
      handled: true,
    };
  }

  if (command.type === "session") {
    const payload = (command.payload ?? "").trim();

    if (!payload || payload === "current") {
      const current = context.sessionManager.getCurrentSession();
      const activeSkills =
        current.activeSkills && current.activeSkills.length > 0
          ? ` skills=${current.activeSkills.join(",")}`
          : "";
      const approvals = current.pendingApprovals?.length ?? 0;
      const mode = current.permissionMode ?? "default";
      const plan =
        current.planState?.active || current.planState?.status
          ? ` plan=${current.planState?.status ?? "inactive"}`
          : "";
      const displayNameInfo = current.displayName ? ` displayName="${current.displayName}"` : "";
      const projectInfo = current.projectBound && current.projectDir
        ? ` projectDir=${current.projectDir} permission=${current.permission} projectBound=true`
        : " projectDir=none permission=chat-only projectBound=false";
      const devTaskInfo = current.devTaskState
        ? ` devTask=${current.devTaskState.status} fixRounds=${current.devTaskState.fixRounds}`
        : "";
      const output = `[session] current: ${current.id} (${current.name})${displayNameInfo} messages=${current.messageCount}${activeSkills} approvals=${approvals} mode=${mode}${plan}${projectInfo}${devTaskInfo}`;
      console.log(output);
      recordToCurrentSession("assistant", output);
      return {
        handled: true,
      };
    }

    if (payload === "list") {
      const currentId = context.sessionManager.getCurrentSessionId();
      const sessions = context.sessionManager.listSessions();

      console.log("[session] list");
      sessions.forEach((session) => {
        const currentFlag = session.id === currentId ? "*" : " ";
        const displayLabel = session.displayName ?? session.name;
        const skillSuffix =
          session.activeSkills && session.activeSkills.length > 0
            ? ` | skills=${session.activeSkills.join(",")}`
            : "";
        const approvalSuffix = ` | approvals=${session.pendingApprovals?.length ?? 0}`;
        const modeSuffix = ` | mode=${session.permissionMode ?? "default"}`;
        const planSuffix = session.planState ? ` | plan=${session.planState.status}` : "";
        const projectSuffix = session.projectBound && session.projectDir
          ? ` | bound=${session.projectDir}`
          : "";
        console.log(
          `${currentFlag} ${session.id} | ${displayLabel} | messages=${session.messageCount}${skillSuffix}${approvalSuffix}${modeSuffix}${planSuffix}${projectSuffix}`
        );
      });

      recordToCurrentSession(
        "assistant",
        `[session] listed ${sessions.length} session(s).`
      );
      return {
        handled: true,
      };
    }

    if (payload.startsWith("new")) {
      const name = payload.replace(/^new\s*/, "").trim() || undefined;
      const created = context.sessionManager.createSession(name);
      const output = `[session] switched to new session: ${created.id} (${created.name})`;
      console.log(output);
      recordToCurrentSession("assistant", output);
      return {
        handled: true,
      };
    }

    if (payload === "switch" || payload.startsWith("switch ")) {
      const targetId = payload.replace(/^switch\s*/, "").trim();

      if (!targetId) {
        const output = "[session] missing sessionId. usage: :session switch <sessionId>";
        console.log(output);
        recordToCurrentSession("assistant", output);
        return {
          handled: true,
        };
      }

      const switched = context.sessionManager.switchSession(targetId);
      if (!switched) {
        const output = `[session] not found: ${targetId}`;
        console.log(output);
        recordToCurrentSession("assistant", output);
        return {
          handled: true,
        };
      }

      const output = `[session] switched: ${switched.id} (${switched.name})`;
      console.log(output);
      recordToCurrentSession("assistant", output);
      return {
        handled: true,
      };
    }

    if (payload === "rename" || payload.startsWith("rename ")) {
      const name = payload.replace(/^rename\s*/, "").trim();

      if (!name) {
        const output = "[session] missing name. usage: :session rename <name>";
        console.log(output);
        recordToCurrentSession("assistant", output);
        return {
          handled: true,
        };
      }

      const renamed = context.sessionManager.renameCurrentSession(name);
      const output = `[session] renamed: ${renamed.id} (${renamed.name})`;
      console.log(output);
      recordToCurrentSession("assistant", output);
      return {
        handled: true,
      };
    }

    const fallback =
      "[session] unknown subcommand. usage: :session | :session current | :session list | :session new [name] | :session switch <sessionId> | :session rename <name>";
    console.log(fallback);
    recordToCurrentSession("assistant", fallback);

    return {
      handled: true,
    };
  }

  if (command.type === "new-chat") {
    const name = (command.payload ?? "").trim() || undefined;
    context.sessionManager.summarizeSession();
    const created = context.sessionManager.createSession(name);
    const output = `[new-chat] created session: ${created.id} (${created.name})\n  permission: ${created.permission}\n  projectBound: ${created.projectBound}\n  projectDir: ${created.projectDir ?? "none"}`;
    console.log(output);
    return {
      handled: true,
    };
  }

  if (command.type === "new-session") {
    const projectDir = (command.payload ?? "").trim();

    context.sessionManager.summarizeSession();
    const created = context.sessionManager.createSession();

    if (!projectDir) {
      const output = `[new-session] created session: ${created.id} (${created.name})\n  permission: chat-only\n  projectDir: none\n  hint: use :bind <projectDir> to bind a project`;
      console.log(output);
      return {
        handled: true,
      };
    }

    try {
      const { session, scan } = context.sessionManager.bindProjectDir(created.id, projectDir);
      const lines = [
        `[new-session] created and bound:`,
        `  sessionId: ${session.id}`,
        `  displayName: ${session.displayName ?? session.name}`,
        `  projectDir: ${session.projectDir}`,
        `  permission: ${session.permission}`,
        `  projectBound: ${session.projectBound}`,
        `  commandCwd: ${session.commandCwd}`,
        `  allowedReadRoots: ${session.allowedReadRoots.join(", ")}`,
        `  allowedWriteRoots: ${session.allowedWriteRoots.join(", ")}`,
        `  scan:`,
        `    .git: ${scan.hasGit}${scan.gitBranch ? ` (${scan.gitBranch})` : ""}${scan.gitClean !== undefined ? ` clean=${scan.gitClean}` : ""}`,
        `    package.json: ${scan.hasPackageJson}`,
        `    pyproject.toml: ${scan.hasPyprojectToml}`,
        `    pom.xml: ${scan.hasPomXml}`,
        `    build.gradle: ${scan.hasBuildGradle}`,
        `    oh-package.json5: ${scan.hasOhPackageJson5}`,
        `    CMakeLists.txt: ${scan.hasCmakeLists}`,
      ];
      if (scan.possibleTestCommand) {
        lines.push(`    test command: ${scan.possibleTestCommand}`);
      }
      if (scan.possibleBuildCommand) {
        lines.push(`    build command: ${scan.possibleBuildCommand}`);
      }
      console.log(lines.join("\n"));
    } catch (err) {
      const output = `[new-session] created session ${created.id} but bind failed: ${err instanceof Error ? err.message : String(err)}`;
      console.log(output);
    }

    return {
      handled: true,
    };
  }

  if (command.type === "bind") {
    const projectDir = (command.payload ?? "").trim();
    if (!projectDir) {
      const output = "[bind] missing projectDir. usage: :bind <projectDir>";
      console.log(output);
      return {
        handled: true,
      };
    }

    try {
      const currentSessionId = context.sessionManager.getCurrentSessionId();
      const { session, scan } = context.sessionManager.bindProjectDir(currentSessionId, projectDir);
      const lines = [
        `[bind] project bound successfully:`,
        `  sessionId: ${session.id}`,
        `  displayName: ${session.displayName ?? session.name}`,
        `  projectDir: ${session.projectDir}`,
        `  permission: ${session.permission}`,
        `  projectBound: ${session.projectBound}`,
        `  commandCwd: ${session.commandCwd}`,
        `  allowedReadRoots: ${session.allowedReadRoots.join(", ")}`,
        `  allowedWriteRoots: ${session.allowedWriteRoots.join(", ")}`,
        `  scan:`,
        `    .git: ${scan.hasGit}${scan.gitBranch ? ` (${scan.gitBranch})` : ""}${scan.gitClean !== undefined ? ` clean=${scan.gitClean}` : ""}`,
        `    package.json: ${scan.hasPackageJson}`,
        `    pyproject.toml: ${scan.hasPyprojectToml}`,
        `    pom.xml: ${scan.hasPomXml}`,
        `    build.gradle: ${scan.hasBuildGradle}`,
        `    oh-package.json5: ${scan.hasOhPackageJson5}`,
        `    CMakeLists.txt: ${scan.hasCmakeLists}`,
      ];
      if (scan.possibleTestCommand) {
        lines.push(`    test command: ${scan.possibleTestCommand}`);
      }
      if (scan.possibleBuildCommand) {
        lines.push(`    build command: ${scan.possibleBuildCommand}`);
      }
      const output = lines.join("\n");
      console.log(output);
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      try {
        const conflict = JSON.parse(rawMessage);
        if (conflict.code === "PROJECT_DIR_CONFLICT") {
          const output = `[bind] PROJECT_DIR_CONFLICT\n  ${conflict.message}\n  hint: ${conflict.suggestion}`;
          console.log(output);
          return { handled: true };
        }
      } catch { /* not JSON, fall through */ }
      const output = `[bind] failed: ${rawMessage}`;
      console.log(output);
    }

    return {
      handled: true,
    };
  }

  if (command.type === "flush") {
    const decision = context.sandbox.canWriteMemory("flush");
    if (!decision.allowed) {
      console.log(decision.reason);
      recordToCurrentSession("assistant", decision.reason ?? "[sandbox] blocked flush");
      return {
        handled: true,
      };
    }

    const res = preCompactionFlush(context.sessionManager.getCurrentSessionId());
    upsertFileIndex(resolveWorkspacePath("MEMORY.md"));

    console.log("[pre-compaction flush]", res);
    recordToCurrentSession("tool", `[pre-compaction flush] ${res.message}`);

    return {
      handled: true,
    };
  }

  if (command.type === "recover") {
    const ctx = postCompactionRecovery();

    console.log("[post-compaction recovery]");
    for (const file of ctx.bootstrapFiles) {
      console.log(`- ${file.name}: ${file.missing ? "missing" : "ok"}`);
    }

    recordToCurrentSession(
      "tool",
      "[post-compaction recovery] restored from flush."
    );

    return {
      handled: true,
    };
  }

  if (command.type === "compact") {
    const decision = context.sandbox.canWriteMemory("compact");
    if (!decision.allowed) {
      console.log(decision.reason);
      recordToCurrentSession("assistant", decision.reason ?? "[sandbox] blocked compact");
      return {
        handled: true,
      };
    }

    const result = compactTranscript(context.sessionManager.getCurrentSessionId());
    const output = `[session] compacted flushed=${result.flushed} target=${result.target} truncated=${result.truncated}`;
    console.log(output);
    recordToCurrentSession("tool", output);

    return {
      handled: true,
    };
  }

  if (command.type === "remember") {
    const text = command.payload ?? "";

    if (!text) {
      console.log("[memory] empty content, skipped.");
      recordToCurrentSession("assistant", "[memory] empty content, skipped.");

      return {
        handled: true,
      };
    }

    // 先分类，再决定落到长期记忆还是当日日志记忆。
    const decision = context.sandbox.canWriteMemory("remember");
    if (!decision.allowed) {
      console.log(decision.reason);
      recordToCurrentSession("assistant", decision.reason ?? "[sandbox] blocked remember");

      return {
        handled: true,
      };
    }

    const kind = classifyMemory(text);

    if (kind === "long-term") {
      writeLongTermMemory(text);

      console.log("[saved] MEMORY.md");
      recordToCurrentSession("assistant", "[saved] MEMORY.md");

      return {
        handled: true,
      };
    }

    writeDailyMemory(text);

    console.log("[saved] daily memory");
    recordToCurrentSession("assistant", "[saved] daily memory");

    return {
      handled: true,
    };
  }

  if (command.type === "search-memory") {
    const query = command.payload ?? "";

    if (!query) {
      console.log("[search] empty query");
      recordToCurrentSession("assistant", "[search] empty query");

      return {
        handled: true,
      };
    }

    const hits = await hybridSearch(query, context.memoryTopK);

    if (hits.length === 0) {
      console.log("[search] no hits");
      recordToCurrentSession("assistant", "[search] no hits");

      return {
        handled: true,
      };
    }

    console.log("[search results]");
    hits.forEach((hit, idx) => {
      console.log(`\n#${idx + 1}`);
      console.log(`file: ${hit.filePath}`);
      console.log(`section: ${hit.section}`);
      console.log(hit.content.slice(0, 200));
    });

    // transcript 内只写摘要，避免把大段检索内容无上限灌进会话日志。
    const summary = hits
      .map((h, i) => `#${i + 1}: ${h.content.slice(0, 80)}`)
      .join("\n");

    recordToCurrentSession("assistant", `[search results]\n${summary}`);

    return {
      handled: true,
    };
  }

  if (command.type === "read-file") {
    const file = command.payload ?? "";

    if (!file) {
      console.log("[file] empty path");
      recordToCurrentSession("assistant", "[file] empty path");

      return {
        handled: true,
      };
    }

    const toolCallRecord = await context.toolCallExecutor.execute(
      createGatewayToolCallRequest({
        toolName: "file.read",
        input: {
          path: file,
        },
        sessionId: context.sessionManager.getCurrentSessionId(),
        permissionMode:
          context.sessionManager.getCurrentSession().permissionMode ?? "default",
        planState: context.sessionManager.getCurrentSession().planState,
        projectBoundary: extractProjectBoundary(context.sessionManager.getCurrentSession()),
      })
    );
    printToolCallRecord(toolCallRecord);
    recordToCurrentSession(
      "assistant",
      `[tool-call] ${toolCallRecord.toolName} ${toolCallRecord.status} (${toolCallRecord.id})`
    );

    return {
      handled: true,
    };
  }

  return {
    handled: false,
  };
}

/**
 * 函数 `createPlanState` 的职责说明。
 * `createPlanState` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function createPlanState(
  sessionId: string,
  existing?: GatewayPlanState
): GatewayPlanState {
  const now = new Date().toISOString();
  const planId =
    existing?.planId ?? `plan-${sessionId}-${Date.now().toString(36)}`;
  const planPath =
    existing?.planPath ?? resolveWorkspacePath("plans", `${sessionId}.md`);

  return {
    active: true,
    status: "draft",
    planId,
    planPath,
    content: existing?.content,
    summary: existing?.summary,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

/**
 * 函数 `persistPlanState` 的职责说明。
 * `persistPlanState` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function persistPlanState(planState: GatewayPlanState): void {
  if (!planState.planPath) {
    return;
  }

  fs.mkdirSync(resolveWorkspacePath("plans"), { recursive: true });
  const body = [
    `# Plan ${planState.planId ?? ""}`.trim(),
    "",
    `status: ${planState.status}`,
    `active: ${String(planState.active)}`,
    `updatedAt: ${planState.updatedAt ?? new Date().toISOString()}`,
    "",
    planState.content ?? "_No plan content yet._",
    "",
  ].join("\n");
  fs.writeFileSync(planState.planPath, body, "utf8");
}

/**
 * 函数 `normalizePlanApprovalMode` 的职责说明。
 * `normalizePlanApprovalMode` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function normalizePlanApprovalMode(
  payload: string
): GatewayPlanApprovalMode {
  if (payload === "execute_fresh") {
    return "execute_fresh";
  }
  if (payload === "execute_with_context") {
    return "execute_with_context";
  }

  return "approve";
}
