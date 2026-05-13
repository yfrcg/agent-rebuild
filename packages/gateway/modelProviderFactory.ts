
import { MockModelProvider } from "../model/mockProvider";
import { TokenPlanProvider } from "../model/tokenPlanProvider";
import type {
  ChatMessage,
  ModelGenerateOptions,
  ModelProvider,
  ModelResponse,
} from "../model/types";
import type { GatewayModelName } from "./config";

export const MODEL_PROVIDER_OPTIONS: Array<{
  id: GatewayModelName;
  label: string;
}> = [
  { id: "tokenplan", label: "MiniMax TokenPlan" },
  { id: "mock", label: "Mock" },
];

/**
 * 根据配置创建模型提供商实例。
 *
 * 当前项目只支持 `tokenplan`，因此这里返回值非常直接。
 * 但保留工厂函数可以为未来增加更多模型时提供稳定扩展点。
 */
export function createModelProvider(model: GatewayModelName): ModelProvider {
  if (model === "mock") {
    return new MockModelProvider();
  }

  return new TokenPlanProvider();
}

export class SwitchableModelProvider implements ModelProvider {
  private currentModel: GatewayModelName;
  private currentProvider: ModelProvider;

  constructor(initialModel: GatewayModelName) {
    this.currentModel = initialModel;
    this.currentProvider = createModelProvider(initialModel);
  }

  get name(): string {
    return this.currentProvider.name;
  }

  get model(): GatewayModelName {
    return this.currentModel;
  }

  get supportsStreaming(): boolean | undefined {
    return this.currentProvider.supportsStreaming;
  }

  setModel(model: GatewayModelName): void {
    if (model === this.currentModel) {
      return;
    }
    this.currentModel = model;
    this.currentProvider = createModelProvider(model);
  }

  generate(
    messages: ChatMessage[],
    options?: ModelGenerateOptions
  ): Promise<ModelResponse> {
    return this.currentProvider.generate(messages, options);
  }
}

export function createSwitchableModelProvider(
  initialModel: GatewayModelName
): SwitchableModelProvider {
  return new SwitchableModelProvider(initialModel);
}
