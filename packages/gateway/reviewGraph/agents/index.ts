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

export function getAgentByNode(
  node: AgentDefinition["node"]
): AgentDefinition | undefined {
  return ALL_AGENTS.find((agent) => agent.node === node);
}
