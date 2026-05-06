
export type GraphNode =
  | "explore"
  | "plan"
  | "implement"
  | "test"
  | "verify"
  | "security"
  | "reviewer";

export type TaskType =
  | "feature"
  | "bugfix"
  | "refactor"
  | "test"
  | "docs"
  | "other";

export type FinalStatus =
  | "passed"
  | "failed"
  | "blocked"
  | "needs_approval"
  | "timeout";

export type PolicyDecision = "allow" | "deny" | "warn";

export type Verdict = "pass" | "fail" | "uncertain";

export type Recommendation =
  | "pass"
  | "needs_minor_fix"
  | "needs_rework";

export type SecurityDecision = "allow" | "deny" | "needs_approval";

export type ReviewDecision = "approved" | "rejected" | "needs_revision";

export interface ExploreResult {
  relevantFiles: string[];
  evidence: string[];
  codeStructure: Record<string, unknown>;
  dependencies: string[];
  summary: string;
}

export interface PlanStep {
  id: string;
  description: string;
  targetFiles: string[];
  expectedChanges: string[];
  risks: string[];
}

export interface PlanResult {
  targetFiles: string[];
  steps: PlanStep[];
  risks: string[];
  requiresApproval: boolean;
  estimatedComplexity: "low" | "medium" | "high";
  summary: string;
}

export interface ImplementResult {
  changedFiles: string[];
  diffSummary: string;
  changes: Array<{
    file: string;
    additions: number;
    deletions: number;
    summary: string;
  }>;
  summary: string;
}

export interface TestResultEntry {
  name: string;
  passed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  failureReason?: string;
}

export interface TestResult {
  overallPassed: boolean;
  tests: TestResultEntry[];
  typecheck: TestResultEntry;
  lint: TestResultEntry;
  build: TestResultEntry;
  summary: string;
}

export interface VerifyResult {
  status: Verdict;
  score: number;
  requirementCoverage: Array<{
    requirement: string;
    covered: boolean;
    evidence?: string;
  }>;
  missingCases: string[];
  falsePassRisks: string[];
  recommendation: Recommendation;
  suggestions: string[];
  summary: string;
}

export interface SecurityViolation {
  type:
    | "sensitive_file"
    | "path_escape"
    | "dangerous_command"
    | "network_access"
    | "key_access"
    | "delete_file"
    | "git_push"
    | "chain_risk";
  severity: "block" | "warn";
  detail: string;
  evidence?: string;
}

export interface SecurityResult {
  decision: SecurityDecision;
  violations: SecurityViolation[];
  auditFindings: string[];
  chainRisks: Array<{
    source: string;
    target: string;
    risk: string;
  }>;
  summary: string;
}

export interface ReviewerResult {
  finalDecision: ReviewDecision;
  approved: boolean;
  blockingIssues: string[];
  warnings: string[];
  suggestions: string[];
  testSummary: string;
  verifySummary: string;
  securitySummary: string;
  summary: string;
}

export interface ToolCallRecord {
  toolName: string;
  args: Record<string, unknown>;
  result: {
    ok: boolean;
    content?: unknown;
    error?: string;
  };
  durationMs: number;
  policyDecision: PolicyDecision;
  timestamp: number;
}

export interface AgentResult {
  subRunId: string;
  agentName: string;
  node: GraphNode;
  status: "ok" | "error";
  summary: string;
  payload:
    | ExploreResult
    | PlanResult
    | ImplementResult
    | TestResult
    | VerifyResult
    | SecurityResult
    | ReviewerResult
    | Record<string, unknown>;
  durationMs: number;
  toolCalls: ToolCallRecord[];
  auditRefs: string[];
  error?: string;
}

export interface AgentDefinition {
  name: string;
  node: GraphNode;
  systemPrompt: string;
  allowedTools: string[];
  deniedTools: string[];
  canSpawnAgents: boolean;
  maxToolCalls: number;
}

export interface ToolPolicyCheck {
  allowed: boolean;
  reason?: string;
  violations: string[];
}

export interface ReviewGraphState {
  runId: string;
  parentRunId?: string;
  userGoal: string;
  taskType: TaskType;
  currentNode: GraphNode;
  targetFiles: string[];
  constraints: string[];
  explore?: ExploreResult;
  plan?: PlanResult;
  implement?: ImplementResult;
  test?: TestResult;
  verify?: VerifyResult;
  security?: SecurityResult;
  reviewer?: ReviewerResult;
  repairRounds: number;
  maxRepairRounds: number;
  auditRefs: string[];
  finalStatus?: FinalStatus;
  startTime: number;
  endTime?: number;
}

export interface AgentChainEntry {
  node: GraphNode;
  agentName: string;
  status: "ok" | "error";
  durationMs: number;
  summary: string;
}

export interface AgentReviewReport {
  runId: string;
  userGoal: string;
  taskType: TaskType;
  agentChain: AgentChainEntry[];
  changedFiles: string[];
  testResult: TestResult;
  verifyResult: VerifyResult;
  securityResult: SecurityResult;
  reviewerResult: ReviewerResult;
  finalStatus: FinalStatus;
  repairRounds: number;
  totalDurationMs: number;
  suggestions: string[];
  auditRefs: string[];
}

export interface SubAgentRunOptions {
  runId: string;
  parentRunId?: string;
  node: GraphNode;
  agentName: string;
  systemPrompt: string;
  allowedTools: string[];
  deniedTools: string[];
  canSpawnAgents: boolean;
  maxToolCalls: number;
  userPrompt: string;
  context?: string;
  targetFiles?: string[];
}

export interface ReviewGraphRunnerOptions {
  autoReviewGraphEnabled?: boolean;
  maxRepairRounds?: number;
  maxToolCallsPerAgent?: number;
  timeoutMs?: number;
}
