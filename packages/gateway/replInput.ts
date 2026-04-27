import type { Interface as ReadlineInterface } from "node:readline";

export function askReplInput(
  rl: ReadlineInterface,
  question: string
): Promise<string> {
  return new Promise<string>((resolve) => {
    rl.question(question, resolve);
  });
}