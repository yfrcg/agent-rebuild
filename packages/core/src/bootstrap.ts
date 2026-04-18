import * as fs from "fs";
import * as path from "path";
import { getTodayDateString, getYesterdayDateString, resolveWorkspacePath } from "./config";
import type { BootstrapContext, BootstrapFile } from "./types";
/*
这段代码是你的 AI Agent 系统的**“开机启动/上下文初始化模块”**（Bootstrap Context）。

如果说之前的代码是负责“写记忆”和“搜记忆”，那么这段代码就是负责在 AI 每次启动（或开启新对话）时，为它注入灵魂和基础背景知识的。
在大语言模型（LLM）的应用中，这通常被称为**组装 System Prompt（系统提示词）**的过程。
*/
//安全读取工具
function readFileSafe(filePath: string): BootstrapFile {
  const name = path.basename(filePath);

  if (!fs.existsSync(filePath)) {
    return {
      name,
      path: filePath,
      content: "",
      missing: true,
    };
  }

  return {
    name,
    path: filePath,
    content: fs.readFileSync(filePath, "utf8"),
    missing: false,
  };
}
/*
作用：这是一个带“容错机制”的文件读取器。

为什么需要容错？ 你的 AI 系统依赖很多配置文件。
如果是一个刚克隆下来的新项目，可能 USER.md 或今天的日记本（today.md）还没被创建。如果你用普通的 fs.readFileSync，程序直接就报错崩溃了。

处理方式：它先检查文件存不存在。如果不存在，它不报错，而是返回一个标有 missing: true 且内容为空的对象；如果存在，就把内容读出来，标记为 missing: false。这保证了 AI 能够平滑启动。
*/

//加载启动上下文
export function loadBootstrapContext(): BootstrapContext {
  //今天和昨天的日期。这可以帮助AI建立时间观念。
  const today = getTodayDateString();
  const yesterday = getYesterdayDateString();
  /*
  这里定义了一个包含 8 个关键文件路径的数组，并通过 .map(readFileSafe) 把它们一次性安全读取出来。这些文件构成了 AI Agent 的全部核心上下文：

  AGENTS.md：可能定义了当前系统的多智能体角色分配或当前 Agent 的基本职能。

  SOUL.md：“灵魂设定”。通常包含 AI 的核心人设、语气、底层价值观和绝对要遵守的规则（比如“不要说废话”、“保持幽默”）。

  USER.md：用户画像档案。描述当前在跟 AI 交互的人是谁。

  TOOLS.md：工具说明书。告诉 AI 它可以使用哪些能力（比如我们之前看的 memorySearch 和 writeDailyMemory）。

  WORKFLOW_AUTO.md：自动化工作流定义。告诉 AI 在特定情况下应该按照什么标准流程办事。

  MEMORY.md：我们之前讲过的长期事实记忆（绝对需要记住的东西）。

  memory/昨天 和 memory/今天：短期/近期记忆。让 AI 知道这两天发生了什么，保持对话的连贯性。
  */
  const files = [
    resolveWorkspacePath("AGENTS.md"),
    resolveWorkspacePath("SOUL.md"),
    resolveWorkspacePath("USER.md"),
    resolveWorkspacePath("TOOLS.md"),
    resolveWorkspacePath("WORKFLOW_AUTO.md"),
    resolveWorkspacePath("MEMORY.md"),
    resolveWorkspacePath("memory", `${today}.md`),
    resolveWorkspacePath("memory", `${yesterday}.md`),
  ].map(readFileSafe);
  //返回组装好的数据
  return {
    bootstrapFiles: files,
    todayMemoryPath: resolveWorkspacePath("memory", `${today}.md`),
  };
}