import {
  OpenAiCompatibleProvider,
  type OpenAiCompatibleProviderOptions,
} from "./openAiCompatibleProvider";
import type { ChatMessage, ModelGenerateOptions, ModelResponse } from "./types";

export interface TokenPlanProviderOptions extends OpenAiCompatibleProviderOptions {}

function mergeSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const msg of messages) {
    const prev = result[result.length - 1];
    if (msg.role === "system" && prev?.role === "system") {
      prev.content = `${prev.content}\n\n${msg.content}`;
    } else {
      result.push({ ...msg });
    }
  }
  return result;
}

export class TokenPlanProvider extends OpenAiCompatibleProvider {
  constructor(options: TokenPlanProviderOptions = {}) {
    super(
      {
        name: "tokenplan",
        displayName: "MiniMax TokenPlan",
        apiKeyEnvNames: [
          "TOKENPLAN_API_KEY",
          "MINIMAX_TOKENPLAN_API_KEY",
          "MINIMAX_API_KEY",
        ],
        baseUrlEnvName: "TOKENPLAN_BASE_URL",
        modelEnvName: "TOKENPLAN_MODEL",
        maxTokensEnvName: "TOKENPLAN_MAX_TOKENS",
        temperatureEnvName: "TOKENPLAN_TEMPERATURE",
        timeoutMsEnvName: "TOKENPLAN_TIMEOUT_MS",
        defaultBaseUrl: "https://api.minimaxi.com/v1",
        defaultModel: "MiniMax-M2.7",
        defaultMaxTokens: 1024,
        defaultTemperature: 0.7,
        defaultTimeoutMs: 30_000,
      },
      options
    );
  }

  override async generate(
    messages: ChatMessage[],
    options?: ModelGenerateOptions
  ): Promise<ModelResponse> {
    return super.generate(mergeSystemMessages(messages), options);
  }
}

export default TokenPlanProvider;
