import * as fs from "fs";
import * as path from "path";
//process.cwd():获取整个项目代码存放的根目录
export const ROOT_DIR = process.cwd();
//系统强制规定，AI的所有工作，记忆，日志，只能放在workspace的文件夹内。
export const WORKSPACE_DIR = path.join(ROOT_DIR, "workspace");
//确保文件存在，不存在自动创建
export function ensureDir(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}
//AI的时间感（日期格式化工具）
//把 JavaScript 复杂的 Date 对象，转换成极其标准的 YYYY-MM-DD 格式（如 2026-04-18）
export function getDateString(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
//前面的 loadBootstrapContext（开机启动代码）里正是调用了这两个函数，去算出并加载 workspace/memory/2026-04-18.md（今天）和 workspace/memory/2026-04-17.md（昨天）的记忆文件。
export function getTodayDateString() {
  return getDateString(new Date());
}

export function getYesterdayDateString() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return getDateString(date);
}

export function resolveWorkspacePath(...parts: string[]) {
  const fullPath = path.resolve(WORKSPACE_DIR, ...parts);
  const normalizedWorkspace = path.resolve(WORKSPACE_DIR);

  if (!fullPath.startsWith(normalizedWorkspace)) {
    throw new Error("Path escapes workspace");
  }

  return fullPath;
}
/*
假设你的项目工作区目录（WORKSPACE_DIR）是：/app/project

正常读取行为：

传入：resolveWorkspacePath("data/memory.txt")

拼接路径：/app/project/data/memory.txt

安全检查：路径确实以 /app/project 开头，通过。返回路径。

黑客/恶意 AI 行为（路径穿越）：

传入：resolveWorkspacePath("../../windows/system32/config/SAM") 或 resolveWorkspacePath("../../../etc/shadow")

拼接路径：path.resolve 解析 ../ 后，路径变成了 /etc/shadow。

安全检查：/etc/shadow 不是以 /app/project 开头的。触发拦截，抛出错误 "Path escapes workspace"！

总结来说，这是一个为 AI 提供文件系统访问权限时，必须要加的安全锁。它把 AI 的活动范围死死限制在了项目指定的文件夹里。
*/