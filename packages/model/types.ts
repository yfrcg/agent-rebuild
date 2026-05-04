import type { ChatMessage } from "../gateway/types";

/**
 * 复用 Gateway 侧定义的消息结构，避免模型层再重复定义一套。
 */
export type { ChatMessage } from "../gateway/types";

/**
 * 模型调用的统一返回结构。
 *
 * `text` 是业务层真正关心的文本结果，
 * `raw` 则用于调试、审计或保留供应商原始返回体。
 */
export interface ModelResponse {
  text: string;
  raw?: unknown;
}

/**
 * 模型提供商协议。
 *
 * 无论接入哪一家模型，只要实现这个接口，
 * Gateway 就可以用统一方式去调用，不需要知道底层厂商差异。
 */
export interface ModelProvider {
  name: string;
  generate(messages: ChatMessage[]): Promise<ModelResponse>;
}

/**
 * 流式模型提供商扩展接口。
 *
 * 继承 ModelProvider，额外提供 generateStream 方法，
 * 返回 AsyncIterable 逐块输出文本，适用于需要实时显示的场景。
 */
export interface StreamingModelProvider extends ModelProvider {
  generateStream(
    messages: ChatMessage[],
    options?: { signal?: AbortSignal }
  ): AsyncIterable<string>;
}
