import {
  validateCall, rejectStaleConsequential, envelopeFromToolError, selectDiagnosisAction,
  newOperationId, reconcileAmbiguousCommit, decideRecovery, computeEpoch, type EffectRecord,
} from "../../reliability-boundary/plugin/api.ts";
import type { ToolName, MechanismFlags } from "./schemas.ts";

export { newOperationId, computeEpoch, type EffectRecord };

export function validateWorkboardCall(tool: ToolName, args: Record<string, unknown>, st: string, on: boolean) {
  if (!on) return { ok: true as const };
  const base = validateCall({ tool, args, state: st });
  if (!base.ok) return { ok: false as const, error: base.violations[0]?.message ?? "contract_violation" };
  if (tool === "create_issue" && typeof args.title !== "string") return { ok: false as const, error: "title required" };
  if (tool === "transition_issue" && args.to_state === "DONE" && st !== "IN_REVIEW") {
    return { ok: false as const, error: "transition to DONE requires IN_REVIEW" };
  }
  return { ok: true as const };
}

export function checkFreshness(tool: ToolName, exp: string | undefined, act: string, on: boolean) {
  if (!on) return { ok: true as const };
  const d = rejectStaleConsequential(tool, exp, act, ["transition_issue"]);
  return d.ok ? { ok: true as const } : { ok: false as const, error: d.code ?? "stale_capability_epoch" };
}

export function wrapFailure(tool: ToolName, error: string, st: string, rev: number, f: MechanismFlags) {
  if (!f.structured_semantics) return {};
  const sf = envelopeFromToolError({ tool, error, state: st, state_revision: rev });
  return {
    structured_failure: sf,
    ...(f.diagnosis_policy ? { diagnosis_action: selectDiagnosisAction({ structuredFailure: sf }) } : {}),
  };
}

export function reconcileTransition(op: string, prior: EffectRecord | null, n: number, st: string, id: string | null) {
  return reconcileAmbiguousCommit({
    operation_id: op, prior,
    observed: {
      state: st === "DONE" ? "PURCHASED" : st, order_id: id,
      receipt_id: id && st === "DONE" ? `rcpt_${id}` : null, committed_purchase_count: n,
    },
  });
}

export function recoveryAfterReload(st: string, id: string | null) {
  return decideRecovery({
    tools_include_purchase: true, order_state: st === "DONE" ? "PURCHASED" : st,
    order_id: id, receipt_id: id && st === "DONE" ? `rcpt_${id}` : null,
    total_aud: null, budget_aud: 9999, seat_ids: [], price_drift: false, seat_drift: false,
  });
}
