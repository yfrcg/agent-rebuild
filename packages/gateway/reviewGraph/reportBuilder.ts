import type {
  AgentChainEntry,
  AgentReviewReport,
  FinalStatus,
  ReviewGraphState,
} from "./types";

function buildAgentChain(state: ReviewGraphState): AgentChainEntry[] {
  const chain: AgentChainEntry[] = [];

  const nodes = [
    { node: "explore" as const, result: state.explore },
    { node: "plan" as const, result: state.plan },
    { node: "implement" as const, result: state.implement },
    { node: "test" as const, result: state.test },
    { node: "verify" as const, result: state.verify },
    { node: "security" as const, result: state.security },
    { node: "reviewer" as const, result: state.reviewer },
  ];

  for (const { node, result } of nodes) {
    if (result) {
      chain.push({
        node,
        agentName: node.charAt(0).toUpperCase() + node.slice(1),
        status: "ok",
        durationMs: 0,
        summary: result.summary ?? "",
      });
    }
  }

  return chain;
}

function getChangedFiles(state: ReviewGraphState): string[] {
  return state.implement?.changedFiles ?? [];
}

function getTestSummary(state: ReviewGraphState): string {
  if (!state.test) return "No test results available";
  return state.test.summary;
}

function getVerifySummary(state: ReviewGraphState): string {
  if (!state.verify) return "No verification results available";
  return `Status: ${state.verify.status}, Score: ${state.verify.score}/10, Recommendation: ${state.verify.recommendation}`;
}

function getSecuritySummary(state: ReviewGraphState): string {
  if (!state.security) return "No security audit available";
  return `Decision: ${state.security.decision}, Violations: ${state.security.violations.length}`;
}

function getReviewerSummary(state: ReviewGraphState): string {
  if (!state.reviewer) return "No reviewer decision available";
  return `Decision: ${state.reviewer.finalDecision}, Approved: ${state.reviewer.approved}`;
}

function getSuggestions(state: ReviewGraphState): string[] {
  const suggestions: string[] = [];

  if (state.verify?.suggestions) {
    suggestions.push(...state.verify.suggestions);
  }

  if (state.reviewer?.suggestions) {
    suggestions.push(...state.reviewer.suggestions);
  }

  if (state.security?.violations) {
    for (const violation of state.security.violations) {
      if (violation.severity === "warn") {
        suggestions.push(`Security: ${violation.detail}`);
      }
    }
  }

  return suggestions;
}

export function buildReport(state: ReviewGraphState): AgentReviewReport {
  const totalDurationMs = state.endTime
    ? state.endTime - state.startTime
    : Date.now() - state.startTime;

  return {
    runId: state.runId,
    userGoal: state.userGoal,
    taskType: state.taskType,
    agentChain: buildAgentChain(state),
    changedFiles: getChangedFiles(state),
    testResult: state.test ?? {
      overallPassed: false,
      tests: [],
      typecheck: { name: "TypeCheck", passed: false, exitCode: -1, stdout: "", stderr: "", timedOut: false, durationMs: 0 },
      lint: { name: "Lint", passed: false, exitCode: -1, stdout: "", stderr: "", timedOut: false, durationMs: 0 },
      build: { name: "Build", passed: false, exitCode: -1, stdout: "", stderr: "", timedOut: false, durationMs: 0 },
      summary: "No test results",
    },
    verifyResult: state.verify ?? {
      status: "uncertain",
      score: 0,
      requirementCoverage: [],
      missingCases: [],
      falsePassRisks: [],
      recommendation: "needs_rework",
      suggestions: [],
      summary: "No verification results",
    },
    securityResult: state.security ?? {
      decision: "allow",
      violations: [],
      auditFindings: [],
      chainRisks: [],
      summary: "No security audit",
    },
    reviewerResult: state.reviewer ?? {
      finalDecision: "rejected",
      approved: false,
      blockingIssues: ["Review not completed"],
      warnings: [],
      suggestions: [],
      testSummary: getTestSummary(state),
      verifySummary: getVerifySummary(state),
      securitySummary: getSecuritySummary(state),
      summary: "Review not completed",
    },
    finalStatus: state.finalStatus ?? "failed",
    repairRounds: state.repairRounds,
    totalDurationMs,
    suggestions: getSuggestions(state),
    auditRefs: state.auditRefs,
  };
}

export function formatReportAsText(report: AgentReviewReport): string {
  const lines: string[] = [];

  lines.push("# AgentReview Report");
  lines.push("");
  lines.push(`## User Goal`);
  lines.push(report.userGoal);
  lines.push("");
  lines.push(`## Task Type`);
  lines.push(report.taskType);
  lines.push("");
  lines.push(`## Final Status`);
  lines.push(`**${report.finalStatus.toUpperCase()}**`);
  lines.push("");
  lines.push(`## Agent Execution Chain`);
  for (const entry of report.agentChain) {
    lines.push(`- **${entry.agentName}** (${entry.node}): ${entry.status} - ${entry.summary}`);
  }
  lines.push("");
  lines.push(`## Changed Files`);
  if (report.changedFiles.length > 0) {
    for (const file of report.changedFiles) {
      lines.push(`- ${file}`);
    }
  } else {
    lines.push("No files changed");
  }
  lines.push("");
  lines.push(`## Test Results`);
  lines.push(`Overall Passed: ${report.testResult.overallPassed}`);
  lines.push(report.testResult.summary);
  lines.push("");
  lines.push(`## Verification`);
  lines.push(`Status: ${report.verifyResult.status}`);
  lines.push(`Score: ${report.verifyResult.score}/10`);
  lines.push(`Recommendation: ${report.verifyResult.recommendation}`);
  lines.push(report.verifyResult.summary);
  lines.push("");
  lines.push(`## Security Audit`);
  lines.push(`Decision: ${report.securityResult.decision}`);
  lines.push(`Violations: ${report.securityResult.violations.length}`);
  lines.push(report.securityResult.summary);
  lines.push("");
  lines.push(`## Reviewer Decision`);
  lines.push(`Decision: ${report.reviewerResult.finalDecision}`);
  lines.push(`Approved: ${report.reviewerResult.approved}`);
  if (report.reviewerResult.blockingIssues.length > 0) {
    lines.push(`Blocking Issues:`);
    for (const issue of report.reviewerResult.blockingIssues) {
      lines.push(`  - ${issue}`);
    }
  }
  lines.push(report.reviewerResult.summary);
  lines.push("");
  lines.push(`## Suggestions`);
  if (report.suggestions.length > 0) {
    for (const suggestion of report.suggestions) {
      lines.push(`- ${suggestion}`);
    }
  } else {
    lines.push("No suggestions");
  }
  lines.push("");
  lines.push(`## Statistics`);
  lines.push(`Repair Rounds: ${report.repairRounds}`);
  lines.push(`Total Duration: ${(report.totalDurationMs / 1000).toFixed(1)}s`);
  lines.push(`Audit References: ${report.auditRefs.length}`);

  return lines.join("\n");
}
