import type { ChatMessage } from "../gateway/types";

export type { ChatMessage } from "../gateway/types";

export interface ModelResponse {
  text: string;
  raw?: unknown;
}

export interface ModelProvider {
  name: string;

  generate(messages: ChatMessage[]): Promise<ModelResponse>;
}
