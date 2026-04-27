import { MockModelProvider } from "../model/mockProvider";
import { DeepSeekProvider } from "../model/deepseekProvider";
import type { ModelProvider } from "../model/types";
import type { GatewayModelName } from "./config";

export function createModelProvider(model: GatewayModelName): ModelProvider {
  if (model === "deepseek") {
    return new DeepSeekProvider();
  }

  return new MockModelProvider();
}
