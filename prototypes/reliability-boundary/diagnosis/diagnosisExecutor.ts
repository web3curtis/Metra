/**
 * C2 diagnosis executor — enforces action as a gate on subsequent tools.
 */

import type { DiagnosisAction, DiagnosisDecision } from "./diagnosisPolicy.ts";

export type DiagnosisGateState = {
  last_action: DiagnosisAction | null;
  consequential_blocked: boolean;
  must_reconcile_before_retry: boolean;
  must_reobserve_before_retry: boolean;
};

export function createDiagnosisGate(): DiagnosisGateState {
  return {
    last_action: null,
    consequential_blocked: false,
    must_reconcile_before_retry: false,
    must_reobserve_before_retry: false,
  };
}

export function applyDiagnosisDecision(
  gate: DiagnosisGateState,
  decision: DiagnosisDecision,
): DiagnosisGateState {
  const action = decision.action;
  switch (action) {
    case "stop":
    case "escalate":
      return {
        last_action: action,
        consequential_blocked: true,
        must_reconcile_before_retry: false,
        must_reobserve_before_retry: false,
      };
    case "reconcile":
      return {
        last_action: action,
        consequential_blocked: false,
        must_reconcile_before_retry: true,
        must_reobserve_before_retry: false,
      };
    case "reobserve":
      return {
        last_action: action,
        consequential_blocked: false,
        must_reconcile_before_retry: false,
        must_reobserve_before_retry: true,
      };
    case "retry":
      return {
        ...gate,
        last_action: action,
      };
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

export function allowConsequentialCall(
  gate: DiagnosisGateState,
  opts: { reconciled?: boolean; reobserved?: boolean } = {},
): { ok: true } | { ok: false; code: string } {
  if (gate.consequential_blocked) {
    return { ok: false, code: "diagnosis_stop_or_escalate_enforced" };
  }
  if (gate.must_reconcile_before_retry && !opts.reconciled) {
    return { ok: false, code: "diagnosis_reconcile_required" };
  }
  if (gate.must_reobserve_before_retry && !opts.reobserved) {
    return { ok: false, code: "diagnosis_reobserve_required" };
  }
  return { ok: true };
}
