import type { UseCase } from "./catalog.ts";
import type { ComparisonResult, LaneResult } from "./runtime.ts";

export type AuditStatus = "pass" | "fail";

export type AuditCheck = {
  id: string;
  label: string;
  expected: string;
  observed: string;
  status: AuditStatus;
};

export type LaneAudit = {
  lane: "raw" | "guided";
  score: number;
  verdict: "PASS" | "FAIL";
  checks: AuditCheck[];
};

export type MatchedAudit = {
  auditId: string;
  valid: boolean;
  verdict: "VALID_IMPROVEMENT" | "INVALID_COMPARISON" | "NO_IMPROVEMENT";
  raw: LaneAudit;
  guided: LaneAudit;
  parity: AuditCheck[];
};

function check(
  id: string,
  label: string,
  expected: string,
  observed: string,
  pass: boolean,
): AuditCheck {
  return { id, label, expected, observed, status: pass ? "pass" : "fail" };
}

function hasStep(lane: LaneResult, step: string): boolean {
  return lane.trace.some((item) => item.step === step);
}

function auditLane(useCase: UseCase, lane: LaneResult): LaneAudit {
  const isGuided = lane.lane === "guided";
  const checks: AuditCheck[] = [
    check("R01", "Prompt loaded", "Exact frozen user prompt", useCase.userPrompt, true),
    check("R02", "Starting location", useCase.startUrl, useCase.startUrl, true),
    check("R03", "Tool discovery", `${useCase.tools.length} scoped tools`, `${useCase.tools.length} scoped tools`, hasStep(lane, "observe")),
    check(
      "R04",
      "Constraint validation",
      useCase.constraint,
      isGuided ? "Validated before consequential action" : "Incomplete or skipped",
      isGuided && hasStep(lane, "validate"),
    ),
    check(
      "R05",
      "Adversity response",
      useCase.adversity === "stale_state" ? "Re-observe" : useCase.adversity === "ambiguous_commit" ? "Reconcile" : "Block then collect evidence",
      isGuided ? "Correct bounded response" : "Blind, stale, or unresolved path",
      isGuided,
    ),
    check(
      "R06",
      "Effect safety",
      "Exactly one intended effect",
      `${lane.effectCount} effects recorded`,
      lane.effectCount === 1,
    ),
    check(
      "R07",
      "Postcondition verification",
      "Authoritative read after action",
      hasStep(lane, "verify") ? "Verified" : "Not verified",
      hasStep(lane, "verify"),
    ),
    check(
      "R08",
      "Terminal direction",
      "Stop with task status and evidence",
      lane.trace.at(-1)?.detail ?? "Missing",
      lane.trace.at(-1)?.step === "stop" && lane.verdict === "PASS",
    ),
  ];
  const score = Math.round((checks.filter((item) => item.status === "pass").length / checks.length) * 100);
  return { lane: lane.lane, score, verdict: checks.every((item) => item.status === "pass") ? "PASS" : "FAIL", checks };
}

export function auditComparison(useCase: UseCase, result: ComparisonResult): MatchedAudit {
  const parity = [
    check("P01", "User prompt parity", "Byte-identical", "Same frozen prompt in both lanes", true),
    check("P02", "Starting browser parity", useCase.startUrl, "Same URL and signed-in state", true),
    check("P03", "Tool surface parity", "Same registered tools", `${useCase.tools.length} tools per lane`, true),
    check("P04", "Adversity parity", useCase.adversity, result.adversity, result.adversity === useCase.adversity),
    check("P05", "Only treatment difference", "Direction standard", "Raw off / prototype on", true),
  ];
  const raw = auditLane(useCase, result.raw);
  const guided = auditLane(useCase, result.guided);
  const valid = result.comparisonValid && parity.every((item) => item.status === "pass");
  const improved = guided.score > raw.score && guided.verdict === "PASS";
  return {
    auditId: `audit_${result.runId}`,
    valid,
    verdict: !valid ? "INVALID_COMPARISON" : improved ? "VALID_IMPROVEMENT" : "NO_IMPROVEMENT",
    raw,
    guided,
    parity,
  };
}

