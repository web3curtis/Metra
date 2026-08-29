/**
 * C2 — evidence-backed diagnosis policy.
 * Selects retry | reobserve | reconcile | escalate | stop from C1 envelopes
 * and optional Critiqor diagnosis. Does not rewrite raw events.
 */

import type { StructuredFailure } from "../semantics/structuredFailure.ts";

export type DiagnosisAction =
  | "retry"
  | "reobserve"
  | "reconcile"
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

/**
 * Map Critiqor prose recommendation into a bounded action when envelope is thin.
 */
function actionFromCritiqorText(text: string | null | undefined): DiagnosisAction | null {
  if (!text) return null;
  const t = text.toLowerCase();
  if (t.includes("reconcil")) return "reconcile";
  if (t.includes("retry")) return "retry";
  if (t.includes("stop") || t.includes("abort") || t.includes("unsafe")) return "stop";
  if (t.includes("escalat") || t.includes("inspect") || t.includes("review")) return "escalate";
  if (t.includes("re-observ") || t.includes("reobserv") || t.includes("refresh") || t.includes("rediscover"))
    return "reobserve";
  return null;
}

export function selectDiagnosisAction(input: {
  structuredFailure?: StructuredFailure | null;
  critiqorDiagnosis?: CritiqorDiagnosisLite | null;
}): DiagnosisDecision {
  const evidence: string[] = [];
  const sf = input.structuredFailure ?? null;
  const cq = input.critiqorDiagnosis ?? null;

  if (sf) {
    evidence.push(`envelope:${sf.category}`, ...sf.evidence);
    const fromCat = actionFromCategory(sf.category);
    if (fromCat) {
      return {
        action: fromCat,
        rationale: `C1 category ${sf.category} → ${fromCat}`,
        evidence,
        critiqor_used: false,
      };
    }
    const fromRec = actionFromRecoverability(sf.recoverability);
    if (fromRec) {
      return {
        action: fromRec,
        rationale: `C1 recoverability ${sf.recoverability} → ${fromRec}`,
        evidence,
        critiqor_used: false,
      };
    }
  }

  if (cq?.primary_diagnosis) {
    evidence.push("critiqor.diagnosis.v1");
    const failureType = cq.primary_diagnosis.root_cause_failure_type;
    if (failureType === "runtime_error") {
      return {
        action: "escalate",
        rationale: "Critiqor runtime_error → escalate",
        evidence,
        critiqor_used: true,
      };
    }
    if (failureType === "retry_pressure") {
      return {
        action: "stop",
        rationale: "Critiqor retry_pressure → stop (no blind retry)",
        evidence,
        critiqor_used: true,
      };
    }
    const fromText = actionFromCritiqorText(cq.primary_diagnosis.recommended_next_action);
    if (fromText) {
      return {
        action: fromText,
        rationale: `Critiqor recommendation → ${fromText}`,
        evidence,
        critiqor_used: true,
      };
    }
  }

  return {
    action: "escalate",
    rationale: "Insufficient evidence for automatic policy; escalate",
    evidence: evidence.length ? evidence : ["no_envelope_or_critiqor"],
    critiqor_used: Boolean(cq),
  };
}
