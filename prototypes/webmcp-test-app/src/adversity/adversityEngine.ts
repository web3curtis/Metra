/**
 * Shared adversity engine — runs BEFORE mechanism flags.
 * Same adversity_id + payload must be delivered to control and treatment.
 */

export type AdversityId =
  | "none"
  | "contract_ambiguity"
  | "capability_change"
  | "opaque_failure"
  | "client_timeout_after_commit"
  | "reload_after_purchase"
  | "state_drift";

export type AdversityArm = "control" | "treatment" | "unspecified";

export type AdversityPayload = {
  /** Capability epoch after change (B) */
  new_epoch?: string;
  /** Opaque error string thrown/rejected (C1) */
  opaque_error?: string;
  /** Seed for deterministic pairing */
  seed?: string;
};

export type AdversityReceipt = {
  adversity_id: AdversityId;
  payload: AdversityPayload;
  applied_before_mechanisms: true;
  arm: AdversityArm;
  timestamp: string;
};

export function createAdversityReceipt(input: {
  adversity_id: AdversityId;
  payload?: AdversityPayload;
  arm?: AdversityArm;
}): AdversityReceipt {
  const id = input.adversity_id;
  const defaults: AdversityPayload = {};
  switch (id) {
    case "none":
      break;
    case "contract_ambiguity":
      defaults.seed = input.payload?.seed ?? "early_invalid_purchase";
      break;
    case "capability_change":
      defaults.new_epoch = input.payload?.new_epoch ?? "epoch:changed";
      defaults.seed = input.payload?.seed ?? "capability_change";
      break;
    case "opaque_failure":
      defaults.opaque_error =
        input.payload?.opaque_error ?? "opaque_provider_failure";
      defaults.seed = input.payload?.seed ?? "opaque_failure";
      break;
    case "client_timeout_after_commit":
      defaults.seed = input.payload?.seed ?? "client_timeout_after_commit";
      break;
    case "reload_after_purchase":
      defaults.seed = input.payload?.seed ?? "reload_after_purchase";
      break;
    case "state_drift":
      defaults.seed = input.payload?.seed ?? "state_drift";
      break;
    default: {
      const _exhaustive: never = id;
      void _exhaustive;
    }
  }
  return {
    adversity_id: id,
    payload: { ...defaults, ...input.payload },
    applied_before_mechanisms: true,
    arm: input.arm ?? "unspecified",
    timestamp: new Date().toISOString(),
  };
}

export function adversityReceiptsMatch(
  a: AdversityReceipt,
  b: AdversityReceipt,
): boolean {
  return (
    a.adversity_id === b.adversity_id &&
    a.applied_before_mechanisms === b.applied_before_mechanisms &&
    JSON.stringify(a.payload) === JSON.stringify(b.payload)
  );
}

export function assertMatchedAdversity(
  control: AdversityReceipt,
  treatment: AdversityReceipt,
): { ok: true } | { ok: false; reason: string } {
  if (!adversityReceiptsMatch(control, treatment)) {
    return {
      ok: false,
      reason: "adversity_receipt_mismatch_invalidates_comparison",
    };
  }
  return { ok: true };
}

/** Exact cumulative stage flags — omitted flags are false, never all-on. */
export type StageFlagMatrix = {
  contract_conformance: boolean;
  capability_freshness: boolean;
  structured_semantics: boolean;
  diagnosis_policy: boolean;
  effect_safety: boolean;
  state_recovery: boolean;
};

export function exactStageFlags(
  stage: "off" | "A" | "B" | "C1" | "C2" | "D1" | "D2" | "full",
): StageFlagMatrix {
  const off: StageFlagMatrix = {
    contract_conformance: false,
    capability_freshness: false,
    structured_semantics: false,
    diagnosis_policy: false,
    effect_safety: false,
    state_recovery: false,
  };
  switch (stage) {
    case "off":
      return off;
    case "A":
      return { ...off, contract_conformance: true };
    case "B":
      return { ...off, contract_conformance: true, capability_freshness: true };
    case "C1":
      return {
        ...off,
        contract_conformance: true,
        capability_freshness: true,
        structured_semantics: true,
      };
    case "C2":
      return {
        ...off,
        contract_conformance: true,
        capability_freshness: true,
        structured_semantics: true,
        diagnosis_policy: true,
      };
    case "D1":
      return {
        ...off,
        contract_conformance: true,
        capability_freshness: true,
        structured_semantics: true,
        diagnosis_policy: true,
        effect_safety: true,
      };
    case "D2":
    case "full":
      return {
        contract_conformance: true,
        capability_freshness: true,
        structured_semantics: true,
        diagnosis_policy: true,
        effect_safety: true,
        state_recovery: true,
      };
    default: {
      const _exhaustive: never = stage;
      return _exhaustive;
    }
  }
}

export function assertExactFlags(
  requested: StageFlagMatrix,
  actual: StageFlagMatrix,
): { ok: true } | { ok: false; reason: string } {
  const keys = Object.keys(requested) as (keyof StageFlagMatrix)[];
  for (const k of keys) {
    if (requested[k] !== actual[k]) {
      return { ok: false, reason: `flag_mismatch:${k}` };
    }
  }
  return { ok: true };
}
