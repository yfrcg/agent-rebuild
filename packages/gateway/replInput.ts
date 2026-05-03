import type { Interface as ReadlineInterface } from "node:readline";

/**
 * 以 Promise 形式读取一行终端输入。
 *
 * `readline.question()` 本身是回调风格，
 * 这里包一层 Promise 后，主循环就可以用 `await` 线性地书写交互流程。
 */
export function askReplInput(
  rl: ReadlineInterface,
  question: string
): Promise<string> {
  return new Promise<string>((resolve) => {
    rl.question(question, resolve);
  });
}
