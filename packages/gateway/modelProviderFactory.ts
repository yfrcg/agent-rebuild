import { MockModelProvider } from "../model/mockProvider";
import { MiniMaxProvider } from "../model/minimaxProvider";
import type { ModelProvider } from "../model/types";
import type { GatewayModelName } from "./config";

export function createModelProvider(model: GatewayModelName): ModelProvider {
  if (model === "minimax") {
    return new MiniMaxProvider();
  }

  return new MockModelProvider();
}