/**
 * Plugin-shaped exports for universal agent skill / host integration.
 * Site-agnostic surface over A–D2 modules.
 */

export {
  validateCall,
  validateOutput,
} from "../contract/contractV0.ts";
export {
  computeEpoch,
  rejectStaleConsequential,
} from "../freshness/capabilityFreshness.ts";
export {
  envelopeFromToolError,
  buildStructuredFailure,
  type StructuredFailure,
} from "../semantics/structuredFailure.ts";
export {
  selectDiagnosisAction,
  type DiagnosisAction,
  type DiagnosisDecision,
} from "../diagnosis/diagnosisPolicy.ts";
export {
  beginEffect,
  markCommitted,
  markUnknown,
  newOperationId,
  reconcileAmbiguousCommit,
  rejectDuplicateOperation,
  type EffectRecord,
  type ReconcileResult,
} from "../effect/effectSafety.ts";
export {
  decideRecovery,
  type RecoveryAction,
  type RecoveryDecision,
  type ObservedRuntime,
} from "../recovery/stateRecovery.ts";

export const PLUGIN_ID = "webmcp-reliability-boundary";
export const PLUGIN_VERSION = "1.0.0";

export type PluginMechanism =
  | "contract_conformance"
  | "capability_freshness"
  | "structured_semantics"
  | "diagnosis_policy"
  | "effect_safety"
  | "state_recovery";

/** Documented invoke order for agents using the skill. */
export const PLUGIN_INVOKE_ORDER: PluginMechanism[] = [
  "contract_conformance",
  "capability_freshness",
  "structured_semantics",
  "diagnosis_policy",
  "effect_safety",
  "state_recovery",
];
