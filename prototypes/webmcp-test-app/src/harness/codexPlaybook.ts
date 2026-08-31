/**
 * Critiqor playbook application for the Codex agent profile.
 * Derived from run_001 recommendations:
 * - Inspect highest-impact runtime error / replay evidence
 * - Never blind-retry consequential tools
 * - Honor diagnosis_action: reobserve | reconcile | escalate | stop
 */

import type { DiagnosisAction, DiagnosisDecision } from "../../../reliability-boundary/diagnosis/diagnosisPolicy.ts";

export type PlaybookStep = {
  action: DiagnosisAction | "continue" | "refresh_epoch" | "inspect_evidence";
  rationale: string;
  from_critiqor_playbook: boolean;
};

export type PlaybookOutcome = {
  followed: boolean;
  steps: PlaybookStep[];
  halted: boolean;
  recovered: boolean;
  blind_retry_attempted: boolean;
};

/** Critiqor dashboard playbook text (run_001) → concrete agent rules. */
export const CRITIQOR_PLAYBOOK_RULES = [
  "Inspect the highest-impact runtime error and replay the supporting evidence timeline before acting.",
  "On structured_failure or diagnosis_action, follow the action — never blind-retry purchase_tickets.",
  "reobserve → refresh capability epoch / rediscover tools, then continue from verified state.",
  "reconcile → get_order with operation_id; reuse receipt if committed; do not second purchase.",
  "stop | escalate → halt consequential tools; surface evidence to manager/user.",
] as const;

export function applyCritiqorPlaybook(input: {
  diagnosis?: DiagnosisDecision | null;
  error?: string | null;
  hasStructuredFailure?: boolean;
}): PlaybookStep {
  const d = input.diagnosis;
  if (d?.action === "reobserve") {
    return {
      action: "refresh_epoch",
      rationale: `${d.rationale}; Critiqor playbook: replay evidence then rediscover before retry`,
      from_critiqor_playbook: true,
    };
  }
  if (d?.action === "reconcile") {
    return {
      action: "reconcile",
      rationale: `${d.rationale}; Critiqor playbook: inspect commit evidence before any retry`,
      from_critiqor_playbook: true,
    };
  }
  if (d?.action === "stop" || d?.action === "escalate") {
    return {
      action: d.action,
      rationale: `${d.rationale}; Critiqor playbook: halt consequential tools`,
      from_critiqor_playbook: true,
    };
  }
  if (d?.action === "retry_safe") {
    return {
      action: "inspect_evidence",
      rationale: "Critiqor playbook forbids blind retry; inspect evidence first",
      from_critiqor_playbook: true,
    };
  }
  if (input.error && !input.hasStructuredFailure) {
    return {
      action: "inspect_evidence",
      rationale: "Opaque error — Critiqor playbook: inspect highest-impact evidence before acting",
      from_critiqor_playbook: true,
    };
  }
  if (input.error) {
    return {
      action: "stop",
      rationale: "Unhandled tool error — stop rather than blind-retry",
      from_critiqor_playbook: true,
    };
  }
  return {
    action: "continue",
    rationale: "No failure signal",
    from_critiqor_playbook: false,
  };
}

export function emptyPlaybookOutcome(): PlaybookOutcome {
  return {
    followed: true,
    steps: [],
    halted: false,
    recovered: false,
    blind_retry_attempted: false,
  };
}
