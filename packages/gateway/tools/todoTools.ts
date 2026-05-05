import * as fs from "node:fs";
import * as path from "node:path";

import { resolveProjectRoot } from "../../core/src/config";
import { createToolSecurityProfile } from "../toolSecurityProfile";
import type { GatewayTool, GatewayToolInput, GatewayToolOutput } from "../toolTypes";

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

function getTodoPath(projectRoot: string): string {
  return path.join(projectRoot, ".agent-rebuild", "todos.json");
}

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

function writeTodos(projectRoot: string, todos: TodoItem[]): void {
  const filePath = getTodoPath(projectRoot);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(todos, null, 2), "utf8");
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const VALID_STATUSES = new Set(["pending", "in_progress", "done", "blocked"]);
const VALID_PRIORITIES = new Set(["high", "medium", "low"]);

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

function clampNumber(value: unknown, defaultVal: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return defaultVal;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
