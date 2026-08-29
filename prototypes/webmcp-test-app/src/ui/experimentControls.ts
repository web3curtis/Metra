export type DemoCondition = "baseline" | "calibration" | "intervention-preview";

export type MechanismFlags = {
  contract_conformance: boolean;
  capability_freshness: boolean;
  structured_semantics: boolean;
  diagnosis_policy: boolean;
  effect_safety: boolean;
  state_recovery: boolean;
};

export type AdversityId =
  | "none"
  | "contract_ambiguity"
  | "capability_change"
  | "opaque_failure"
  | "reload_after_purchase"
  | "state_drift";

export type ExperimentControls = {
  condition: DemoCondition;
  adversity: AdversityId;
  mechanisms: MechanismFlags;
};

export const DEFAULT_CONTROLS: ExperimentControls = {
  condition: "baseline",
  adversity: "none",
  mechanisms: {
    contract_conformance: false,
    capability_freshness: false,
    structured_semantics: false,
    diagnosis_policy: false,
    effect_safety: false,
    state_recovery: false,
  },
};

export function allMechanismsOff(flags: MechanismFlags): boolean {
  return Object.values(flags).every((v) => v === false);
}

export function describeControls(c: ExperimentControls): string {
  const on = Object.entries(c.mechanisms)
    .filter(([, v]) => v)
    .map(([k]) => k);
  return `condition=${c.condition}; adversity=${c.adversity}; mechanisms=${on.length ? on.join(",") : "none"}`;
}
