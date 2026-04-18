import * as fs from "fs";//用于操作文件
import { resolveWorkspacePath } from "../../core/src/config";//引入的自定义函数，将哟个相对路径转换为项目中的绝对路径
//读取file的真实路径，？代表可选
export function memoryGet(file: string, startLine?: number, endLine?: number) { 
  const filePath = resolveWorkspacePath(file);
  //检查文件是否存在
  if (!fs.existsSync(filePath)) {
    throw new Error(`Memory file not found: ${file}`);
  }
  //读取文件与行号计算
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  const s = startLine ? Math.max(1, startLine) : 1;
  const e = endLine ? Math.min(lines.length, endLine) : lines.length;

  return {
    file,
    startLine: s,
    endLine: e,
    text: lines.slice(s - 1, e).join("\n"),
  };
}
/*
假设你的项目里有一个文档叫 user_profile.md，里面有 10 行文本。

AI 想读取整个文件：

调用：memoryGet("user_profile.md")

结果：返回第 1 到 10 行的所有内容。

AI 只想看第 3 行到第 5 行的内容：

调用：memoryGet("user_profile.md", 3, 5)

结果：返回第 3 到 5 行的文本，startLine 为 3，endLine 为 5。

AI 发送了一个错误的指令，想看第 -2 行到第 100 行的内容：

调用：memoryGet("user_profile.md", -2, 100)

结果：代码会自动纠错！Math.max 会把 -2 变成 1，Math.min 会把 100 变成 10（因为文件只有 10 行）。最后安全返回第 1 到 10 行的内容。

*/