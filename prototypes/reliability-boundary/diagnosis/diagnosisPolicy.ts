/**
 * C2 — evidence-backed diagnosis policy.
 * Selects continue | retry_safe | reobserve | reconcile | recover | escalate | stop
 * from C1 envelopes. Critiqor is non-authoritative fallback only.
 */

import type { StructuredFailure } from "../semantics/structuredFailure.ts";

export type DiagnosisAction =
  | "continue"
  | "retry_safe"
  | "reobserve"
  | "reconcile"
  | "recover"
  | "escalate"
  | "stop";

export type CritiqorDiagnosisLite = {
  primary_diagnosis?: {
    root_cause_failure_type?: string | null;
    recommended_next_action?: string | null;
    causal_chain_explanation?: string | null;
  };
  evaluation_confidence?: number;
};

export type DiagnosisDecision = {
  action: DiagnosisAction;
  rationale: string;
  evidence: string[];
  critiqor_used: boolean;
};

export type DiagnosisBudgets = {
  reobserve: number;
  reconcile: number;
  recover: number;
  retry_safe: number;
};

const DEFAULT_BUDGETS: DiagnosisBudgets = {
  reobserve: 3,
  reconcile: 3,
  recover: 2,
  retry_safe: 1,
};

/** Precedence: escalate/stop > reconcile > reobserve/recover > retry_safe > continue */
const PRECEDENCE: DiagnosisAction[] = [
  "escalate",
  "stop",
  "reconcile",
  "reobserve",
  "recover",
  "retry_safe",
  "continue",
];

function actionFromCategory(category: string): DiagnosisAction | null {
  switch (category) {
    case "stale_observation_or_capability":
      return "reobserve";
    case "invalid_input_or_precondition":
      return "stop";
    case "ambiguous_commit":
      return "reconcile";
    case "execution_error":
      return "escalate";
    case "malformed_success":
      return "stop";
    default:
      return null;
  }
}

function actionFromRecoverability(
  recoverability: StructuredFailure["recoverability"],
): DiagnosisAction | null {
  switch (recoverability) {
    case "automatic":
      return "reobserve";
    case "manager":
      return "escalate";
    case "user":
      return "escalate";
    case "non_recoverable":
      return "stop";
    case "unknown":
      return null;
    default: {
      const _exhaustive: never = recoverability;
      return _exhaustive;
    }
  }
}

function actionFromCritiqorText(text: string | null | undefined): DiagnosisAction | null {
  if (!text) return null;
  const t = text.toLowerCase();
  if (t.includes("reconcil")) return "reconcile";
  if (t.includes("recover")) return "recover";
  if (t.includes("retry")) return "retry_safe";
  if (t.includes("stop") || t.includes("abort") || t.includes("unsafe")) return "stop";
  if (t.includes("escalat") || t.includes("inspect") || t.includes("review")) return "escalate";
  if (t.includes("re-observ") || t.includes("reobserv") || t.includes("refresh") || t.includes("rediscover"))
    return "reobserve";
  if (t.includes("continue")) return "continue";
  return null;
}

function withinBudget(
  action: DiagnosisAction,
  used: Partial<DiagnosisBudgets>,
  budgets: DiagnosisBudgets,
): boolean {
  if (action === "reobserve") return (used.reobserve ?? 0) < budgets.reobserve;
  if (action === "reconcile") return (used.reconcile ?? 0) < budgets.reconcile;
  if (action === "recover") return (used.recover ?? 0) < budgets.recover;
  if (action === "retry_safe") return (used.retry_safe ?? 0) < budgets.retry_safe;
  return true;
}

export function selectDiagnosisAction(input: {
  structuredFailure?: StructuredFailure | null;
  critiqorDiagnosis?: CritiqorDiagnosisLite | null;
  budgets_used?: Partial<DiagnosisBudgets>;
  budgets?: DiagnosisBudgets;
}): DiagnosisDecision {
  const evidence: string[] = [];
  const sf = input.structuredFailure ?? null;
  const cq = input.critiqorDiagnosis ?? null;
  const budgets = input.budgets ?? DEFAULT_BUDGETS;
  const used = input.budgets_used ?? {};

  const candidates: DiagnosisAction[] = [];

  if (sf) {
    evidence.push(`envelope:${sf.category}`, ...sf.evidence);
    const fromCat = actionFromCategory(sf.category);
    if (fromCat) candidates.push(fromCat);
    else {
      const fromRec = actionFromRecoverability(sf.recoverability);
      if (fromRec) candidates.push(fromRec);
    }
  }

  if (candidates.length === 0 && cq?.primary_diagnosis) {
    evidence.push("critiqor.diagnosis.v1");
    const failureType = cq.primary_diagnosis.root_cause_failure_type;
    if (failureType === "runtime_error") candidates.push("escalate");
    if (failureType === "retry_pressure") candidates.push("stop");
    const fromText = actionFromCritiqorText(cq.primary_diagnosis.recommended_next_action);
    if (fromText) candidates.push(fromText);
  }

  if (candidates.length === 0) {
    return {
      action: "escalate",
      rationale: "Insufficient evidence for automatic policy; escalate",
      evidence: evidence.length ? evidence : ["no_envelope_or_critiqor"],
      critiqor_used: Boolean(cq),
    };
  }

  candidates.sort((a, b) => PRECEDENCE.indexOf(a) - PRECEDENCE.indexOf(b));
  for (const action of candidates) {
    if (!withinBudget(action, used, budgets)) {
      evidence.push(`budget_exhausted:${action}`);
      continue;
    }
    return {
      action,
      rationale: `precedence+budget selected ${action}`,
      evidence,
      critiqor_used: Boolean(cq) && !sf,
    };
  }

  return {
    action: "stop",
    rationale: "All candidate actions exhausted budgets; stop",
    evidence,
    critiqor_used: Boolean(cq),
  };
}
