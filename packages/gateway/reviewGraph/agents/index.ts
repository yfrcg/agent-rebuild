/**
 * ?????CS336 ???
 * ???packages/gateway/reviewGraph/agents/index.ts
 * ???ReviewGraph ? Agent ?????
 * ?????????? Agent ??????????????
 * ???????????????????????????????????? README ????????????????
 */

export { EXPLORE_AGENT } from "./explore";
export { PLAN_AGENT } from "./plan";
export { IMPLEMENT_AGENT } from "./implement";
export { TEST_AGENT } from "./test";
export { VERIFY_AGENT } from "./verify";
export { SECURITY_AGENT } from "./security";
export { REVIEWER_AGENT } from "./reviewer";

import type { AgentDefinition } from "../types";
import { EXPLORE_AGENT } from "./explore";
import { PLAN_AGENT } from "./plan";
import { IMPLEMENT_AGENT } from "./implement";
import { TEST_AGENT } from "./test";
import { VERIFY_AGENT } from "./verify";
import { SECURITY_AGENT } from "./security";
import { REVIEWER_AGENT } from "./reviewer";

export const ALL_AGENTS: AgentDefinition[] = [
  EXPLORE_AGENT,
  PLAN_AGENT,
  IMPLEMENT_AGENT,
  TEST_AGENT,
  VERIFY_AGENT,
  SECURITY_AGENT,
  REVIEWER_AGENT,
];

/**
 * 函数 `getAgentByNode` 的职责说明。
 * `getAgentByNode` 负责读取配置、状态或持久化数据，并把结果整理成调用方需要的形状。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function getAgentByNode(
  node: AgentDefinition["node"]
): AgentDefinition | undefined {
  return ALL_AGENTS.find((agent) => agent.node === node);
}
