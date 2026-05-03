import { DeepSeekProvider } from "../model/deepseekProvider";
import { MockModelProvider } from "../model/mockProvider";
import type { ModelProvider } from "../model/types";
import type { GatewayModelName } from "./config";

/**
 * 根据配置创建模型提供商实例。
 *
 * 当前项目只支持 `deepseek`，因此这里返回值非常直接。
 * 但保留工厂函数可以为未来增加更多模型时提供稳定扩展点。
 */
export function createModelProvider(model: GatewayModelName): ModelProvider {
  if (model === "mock") {
    return new MockModelProvider();
  }

  return new DeepSeekProvider();
}
