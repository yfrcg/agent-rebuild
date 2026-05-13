/**
 * ?????CS336 ???
 * ???packages/model/types.ts
 * ??????????
 * ??????? ModelProvider ???????????????
 * ???????????????????????????????????? README ????????????????
 */

import type { ChatMessage } from "../core/src/types";
export type { ChatMessage } from "../core/src/types";

export interface ModelUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ModelResponse {
  text: string;
  raw?: unknown;
  usage?: ModelUsage;
}

export interface ModelToolDefinition {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

export interface ModelGenerateOptions {
  signal?: AbortSignal;
  onDelta?: (delta: string) => void | Promise<void>;
  responseFormat?: { type: "json_object" | "text" };
  tools?: ModelToolDefinition[];
}

/**
 * 模型提供商协议。
 *
 * 无论接入哪一家模型，只要实现这个接口，
 * Gateway 就可以用统一方式去调用，不需要知道底层厂商差异。
 */
export interface ModelProvider {
  name: string;
  supportsStreaming?: boolean;
  /** 方法 `generate`：承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。 */
  generate(messages: ChatMessage[], options?: ModelGenerateOptions): Promise<ModelResponse>;
}

/**
 * 流式模型提供商扩展接口。
 *
 * 继承 ModelProvider，额外提供 generateStream 方法，
 * 返回 AsyncIterable 逐块输出文本，适用于需要实时显示的场景。
 */
export interface StreamingModelProvider extends ModelProvider {
  /** 方法 `generateStream`：承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。 */
  generateStream(
    messages: ChatMessage[],
    options?: { signal?: AbortSignal }
  ): AsyncIterable<string>;
}
