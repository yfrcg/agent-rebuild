import * as fs from "fs";
import * as path from "path";

/**
 * 项目根目录。
 *
 * 这里直接使用进程启动时的工作目录作为根目录，
 * 便于脚本、CLI 和测试环境共享同一套路径解析规则。
 */
export const ROOT_DIR = process.cwd();

/**
 * 统一的工作区目录。
 *
 * 项目约定所有由 Agent 写入的记忆、日志、会话等数据都落在 `workspace/` 下，
 * 这样可以把“代码区”和“运行态数据区”隔离开。
 */
export const WORKSPACE_DIR = path.join(ROOT_DIR, "workspace");

/**
 * 固定使用的业务时区。
 *
 * 即使服务器本地时区不同，也尽量让日期相关逻辑稳定落在同一时区上，
 * 避免“今天/昨天”判断在部署环境里跑偏。
 */
const TZ = process.env.TZ ?? "Asia/Shanghai";

/**
 * 确保目录存在，不存在时自动递归创建。
 *
 * 这是整个项目最基础的文件系统防御措施之一，
 * 避免后续写文件时因为父目录缺失而直接报错。
 */
export function ensureDir(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * 按固定时区把 `Date` 格式化为 `YYYY-MM-DD`。
 *
 * 这里不直接依赖系统本地时间格式，而是借助 `Intl.DateTimeFormat`
 * 强制输出稳定的日期字符串。
 */
function toLocalDateString(date: Date): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  return fmt.format(date);
}

/**
 * 获取指定日期对应的标准化字符串。
 *
 * 这是日期工具的基础出口，其他“今天”“昨天”函数都基于它实现，
 * 保证整个项目的日期格式始终一致。
 */
export function getDateString(date = new Date()) {
  return toLocalDateString(date);
}

/**
 * 获取当前业务时区下的“今天”日期字符串。
 */
export function getTodayDateString() {
  return toLocalDateString(new Date());
}

/**
 * 获取当前业务时区下的“昨天”日期字符串。
 *
 * 这个函数常用于加载前一天的记忆文件或日志文件，
 * 让模型在冷启动时也能看到最近一段历史。
 */
export function getYesterdayDateString() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return toLocalDateString(date);
}

/**
 * 基于 `workspace/` 解析安全的绝对路径。
 *
 * 这个函数除了做路径拼接，更重要的是阻止路径逃逸：
 * 如果调用方试图通过 `..` 访问工作区外的内容，会直接抛错。
 */
export function resolveWorkspacePath(...parts: string[]) {
  const fullPath = path.resolve(WORKSPACE_DIR, ...parts);
  const normalizedWorkspace = path.resolve(WORKSPACE_DIR);

  if (!fullPath.startsWith(normalizedWorkspace)) {
    throw new Error("Path escapes workspace");
  }

  return fullPath;
}
