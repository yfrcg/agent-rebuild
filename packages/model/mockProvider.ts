import type { ChatMessage } from "../gateway/types";
import type { ModelProvider, ModelResponse } from "./types";

export class MockModelProvider implements ModelProvider {
  name = "mock";

  async generate(messages: ChatMessage[]): Promise<ModelResponse> {
    const lastUserMessage = [...messages]
      .reverse()
      .find((message) => message.role === "user");

    return {
      text:
        "这是 MockModelProvider 的模拟回答。\n\n" +
        `我收到的问题是：${lastUserMessage?.content ?? "未找到用户问题"}\n\n` +
        "后续你可以把我替换成 DeepSeekProvider。",
      raw: {
        provider: this.name,
        messageCount: messages.length,
      },
    };
  }
}