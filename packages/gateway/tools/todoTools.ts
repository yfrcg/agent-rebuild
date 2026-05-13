/**
 * ?????CS336 ???
 * ???packages/gateway/tools/todoTools.ts
 * ??????????
 * ?????????????????????????????
 * ???????????????????????????????????? README ????????????????
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

import { resolveProjectRoot } from "../../core/src/config";
import { createToolSecurityProfile } from "../toolSecurityProfile";
import type { GatewayTool, GatewayToolInput, GatewayToolOutput } from "../toolTypes";

/**
 * 函数 `createTodoTools` 的职责说明。
 * `createTodoTools` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function createTodoTools(projectRoot = resolveProjectRoot()): GatewayTool[] {
  return [
    createTodoWriteTool(projectRoot),
    createTodoUpdateTool(projectRoot),
    createTodoListTool(projectRoot),
  ];
}

interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "done" | "blocked";
  priority?: "high" | "medium" | "low";
  createdAt: string;
  updatedAt: string;
}

/**
 * 函数 `getTodoPath` 的职责说明。
 * `getTodoPath` 负责读取配置、状态或持久化数据，并把结果整理成调用方需要的形状。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function getTodoPath(projectRoot: string): string {
  return path.join(projectRoot, ".agent-rebuild", "todos.json");
}

/**
 * 函数 `readTodos` 的职责说明。
 * `readTodos` 负责读取配置、状态或持久化数据，并把结果整理成调用方需要的形状。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function readTodos(projectRoot: string): TodoItem[] {
  const filePath = getTodoPath(projectRoot);
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(content) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as TodoItem[];
  } catch {
    return [];
  }
}

/**
 * 函数 `writeTodos` 的职责说明。
 * `writeTodos` 负责写入或更新状态，维护时要关注幂等性、失败恢复和数据一致性。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function writeTodos(projectRoot: string, todos: TodoItem[]): void {
  const filePath = getTodoPath(projectRoot);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(todos, null, 2), "utf8");
}

/**
 * 函数 `generateId` 的职责说明。
 * `generateId` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function generateId(): string {
  return Date.now().toString(36) + randomBytes(6).toString("hex");
}

const VALID_STATUSES = new Set(["pending", "in_progress", "done", "blocked"]);
const VALID_PRIORITIES = new Set(["high", "medium", "low"]);

/**
 * 函数 `createTodoWriteTool` 的职责说明。
 * `createTodoWriteTool` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function createTodoWriteTool(projectRoot: string): GatewayTool {
  const schema = {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "Task description.",
      },
      status: {
        type: "string",
        enum: ["pending", "in_progress", "done", "blocked"],
        description: "Initial status (default: pending).",
      },
      priority: {
        type: "string",
        enum: ["high", "medium", "low"],
        description: "Task priority.",
      },
      id: {
        type: "string",
        description: "Custom ID (auto-generated if omitted).",
      },
    },
    required: ["content"],
  } satisfies Record<string, unknown>;

  return {
    name: "todo.write",
    description: "Create a new todo task. Returns the created item with id.",
    schema,
    inputSchema: schema,
    riskLevel: "medium",
    permissionLevel: "write",
    readOnly: false,
    sideEffect: true,
    requiresSandbox: false,
    policy: {
      automationLevel: "auto",
      riskLevel: "stateful",
      tags: ["todo", "task", "write"],
    },
    security: createToolSecurityProfile({
      riskLevel: "medium",
      sandboxRequired: false,
      allowWrite: true,
      allowHostExecution: true,
      requireApproval: false,
    }),
    /** 方法 `invoke`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    async invoke(input) {
      const content = typeof input.content === "string" ? input.content.trim() : "";
      if (!content) {
        return { ok: false, error: "Task content must not be empty." };
      }

      const status = typeof input.status === "string" && VALID_STATUSES.has(input.status)
        ? input.status as TodoItem["status"]
        : "pending";
      const priority = typeof input.priority === "string" && VALID_PRIORITIES.has(input.priority)
        ? input.priority as TodoItem["priority"]
        : undefined;

      const now = new Date().toISOString();
      const item: TodoItem = {
        id: typeof input.id === "string" && input.id.trim() ? input.id.trim() : generateId(),
        content,
        status,
        priority,
        createdAt: now,
        updatedAt: now,
      };

      const todos = readTodos(projectRoot);
      todos.push(item);
      writeTodos(projectRoot, todos);

      return {
        ok: true,
        content: { todo: item, totalTodos: todos.length },
        metadata: { id: item.id },
      };
    },
  };
}

/**
 * 函数 `createTodoUpdateTool` 的职责说明。
 * `createTodoUpdateTool` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function createTodoUpdateTool(projectRoot: string): GatewayTool {
  const schema = {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "ID of the todo to update.",
      },
      status: {
        type: "string",
        enum: ["pending", "in_progress", "done", "blocked"],
        description: "New status.",
      },
      content: {
        type: "string",
        description: "Updated task description.",
      },
      priority: {
        type: "string",
        enum: ["high", "medium", "low"],
        description: "Updated priority.",
      },
    },
    required: ["id"],
  } satisfies Record<string, unknown>;

  return {
    name: "todo.update",
    description: "Update an existing todo task by ID.",
    schema,
    inputSchema: schema,
    riskLevel: "medium",
    permissionLevel: "write",
    readOnly: false,
    sideEffect: true,
    requiresSandbox: false,
    policy: {
      automationLevel: "auto",
      riskLevel: "stateful",
      tags: ["todo", "task", "write"],
    },
    security: createToolSecurityProfile({
      riskLevel: "medium",
      sandboxRequired: false,
      allowWrite: true,
      allowHostExecution: true,
      requireApproval: false,
    }),
    /** 方法 `invoke`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    async invoke(input) {
      const id = typeof input.id === "string" ? input.id.trim() : "";
      if (!id) {
        return { ok: false, error: "Todo ID must not be empty." };
      }

      const todos = readTodos(projectRoot);
      const index = todos.findIndex((t) => t.id === id);
      if (index === -1) {
        return { ok: false, error: `Todo not found: ${id}` };
      }

      const item = todos[index];
      const now = new Date().toISOString();

      if (typeof input.status === "string") {
        if (!VALID_STATUSES.has(input.status)) {
          return { ok: false, error: `Invalid status: ${input.status}` };
        }
        item.status = input.status as TodoItem["status"];
      }
      if (typeof input.content === "string" && input.content.trim()) {
        item.content = input.content.trim();
      }
      if (typeof input.priority === "string") {
        if (!VALID_PRIORITIES.has(input.priority)) {
          return { ok: false, error: `Invalid priority: ${input.priority}` };
        }
        item.priority = input.priority as TodoItem["priority"];
      }
      item.updatedAt = now;

      todos[index] = item;
      writeTodos(projectRoot, todos);

      return {
        ok: true,
        content: { todo: item },
        metadata: { id: item.id },
      };
    },
  };
}

/**
 * 函数 `createTodoListTool` 的职责说明。
 * `createTodoListTool` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function createTodoListTool(projectRoot: string): GatewayTool {
  const schema = {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["pending", "in_progress", "done", "blocked"],
        description: "Filter by status (default: all).",
      },
      limit: {
        type: "number",
        description: "Max items to return (default 50, max 200).",
      },
    },
  } satisfies Record<string, unknown>;

  return {
    name: "todo.list",
    description: "List todo tasks, optionally filtered by status.",
    schema,
    inputSchema: schema,
    riskLevel: "safe",
    permissionLevel: "read",
    readOnly: true,
    sideEffect: false,
    requiresSandbox: false,
    policy: {
      automationLevel: "auto",
      riskLevel: "read-only",
      tags: ["todo", "task", "read"],
    },
    security: createToolSecurityProfile({
      riskLevel: "safe",
      sandboxRequired: false,
      allowHostExecution: true,
      allowWrite: false,
    }),
    /** 方法 `invoke`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    async invoke(input) {
      const statusFilter = typeof input.status === "string" && VALID_STATUSES.has(input.status)
        ? input.status as TodoItem["status"]
        : undefined;
      const limit = clampNumber(input.limit, 50, 1, 200);

      let todos = readTodos(projectRoot);
      if (statusFilter) {
        todos = todos.filter((t) => t.status === statusFilter);
      }

      const limited = todos.slice(0, limit);

      const counts = {
        total: todos.length,
        pending: todos.filter((t) => t.status === "pending").length,
        in_progress: todos.filter((t) => t.status === "in_progress").length,
        done: todos.filter((t) => t.status === "done").length,
        blocked: todos.filter((t) => t.status === "blocked").length,
      };

      return {
        ok: true,
        content: {
          todos: limited,
          counts,
          returned: limited.length,
          truncated: todos.length > limit,
        },
        metadata: { total: todos.length },
      };
    },
  };
}

/**
 * 函数 `clampNumber` 的职责说明。
 * `clampNumber` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function clampNumber(value: unknown, defaultVal: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return defaultVal;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
