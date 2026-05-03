import type { ChatMessage, ModelProvider, ModelResponse } from "./types";

export interface MockModelProviderOptions {
  prefix?: string;
}

/**
 * 一个完全离线、可重复的模型提供商。
 *
 * 主要用于本地开发、单元测试和离线门禁，
 * 避免日常验证依赖真实模型 API。
 */
export class MockModelProvider implements ModelProvider {
  readonly name = "mock";

  private readonly prefix: string;

  constructor(options: MockModelProviderOptions = {}) {
    this.prefix = options.prefix ?? "mock response:";
  }

  async generate(messages: ChatMessage[]): Promise<ModelResponse> {
    const lastUserMessage = [...messages]
      .reverse()
      .find((message) => message.role === "user")?.content;

    if (lastUserMessage?.includes("[AUTO_TOOL_DECISION]")) {
      return {
        text: JSON.stringify({
          action: "respond",
          reason: "Mock model does not autonomously plan tool usage.",
        }),
        raw: {
          messageCount: messages.length,
          mode: "auto-tool-decision",
        },
      };
    }

    const text = `${this.prefix} ${lastUserMessage ?? "no user message"}`.trim();

    return {
      text,
      raw: {
        messageCount: messages.length,
      },
    };
  }
}

export default MockModelProvider;
