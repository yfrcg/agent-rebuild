import * as fs from "fs";
import * as path from "path";

//process.cwd():获取整个项目代码存放的根目录
export const ROOT_DIR = process.cwd();

//系统强制规定，AI的所有工作，记忆，日志，只能放在workspace的文件夹内。
export const WORKSPACE_DIR = path.join(ROOT_DIR, "workspace");

//【时区安全】：强制锁定到 Asia/Shanghai 时区（可被子进程 TZ 环境变量覆盖）
//用途：确保 AI 的"今天是哪一天"不依赖服务器本地时区，在 UTC 服务器上也能正确运行
const TZ = process.env.TZ ?? "Asia/Shanghai";

//确保文件存在，不存在自动创建
export function ensureDir(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

//把 Date 对象格式化为 YYYY-MM-DD（使用固定时区，不依赖服务器本地设置）
function toLocalDateString(date: Date): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  //Intl.DateTimeFormat en-CA 格式输出：YYYY-MM-DD（和 getDateString 结果一致）
  return fmt.format(date);
}

//AI的时间感（日期格式化工具）
//把 JavaScript 复杂的 Date 对象，转换成极其标准的 YYYY-MM-DD 格式（如 2026-04-18）
export function getDateString(date = new Date()) {
  return toLocalDateString(date);
}

//前面的 loadBootstrapContext（开机启动代码）里正是调用了这两个函数，去算出并加载 workspace/memory/2026-04-18.md（今天）和 workspace/memory/2026-04-17.md（昨天）的记忆文件。
export function getTodayDateString() {
  return toLocalDateString(new Date());
}

export function getYesterdayDateString() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return toLocalDateString(date);
}

export function resolveWorkspacePath(...parts: string[]) {
  const fullPath = path.resolve(WORKSPACE_DIR, ...parts);
  const normalizedWorkspace = path.resolve(WORKSPACE_DIR);

  if (!fullPath.startsWith(normalizedWorkspace)) {
    throw new Error("Path escapes workspace");
  }

  return fullPath;
}