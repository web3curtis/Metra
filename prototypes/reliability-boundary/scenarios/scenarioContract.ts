/**
 * Domain-agnostic scenario contract for portability substrate (P0).
 * No imports from ReliableRail domain or store.
 */

/** Named oracle hook for post-run verification without domain coupling. */
export type OracleHook = {
  id: string;
  description: string;
  /** Key into synthetic adversity catalog used by scenarioRunner. */
  adversityKey?: string;
};

/** Workflow state node — generic id + human label. */
export type ScenarioState = {
  id: string;
  label: string;
  /** When true, consequential tool may legally run from this state. */
  allowsConsequential?: boolean;
};

/**
 * External fixture reference: core holds only the pointer; site adapter lives outside.
 */
export type ExternalFixtureRef = {
  adapterId: string;
  fixturePath: string;
};

/**
 * Portable scenario descriptor — consequential tool name is generic per domain.
 */
export type ScenarioContract = {
  id: string;
  label: string;
  version: string;
  /** Domain-specific consequential (mutating) tool name. */
  consequentialTool: string;
  /** Full tool capability set (used for epoch / rediscovery checks). */
  tools: string[];
  states: ScenarioState[];
  initialStateId: string;
  /** State required immediately before consequential invocation. */
  preconditionStateId: string;
  oracleHooks: OracleHook[];
  /** Present when an external app adapter owns the live fixture. */
  externalFixtureRef?: ExternalFixtureRef;
};

export function stateById(
  contract: ScenarioContract,
  stateId: string,
): ScenarioState | undefined {
  return contract.states.find((s) => s.id === stateId);
}

export function allowsConsequentialFrom(
  contract: ScenarioContract,
  stateId: string,
): boolean {
  const state = stateById(contract, stateId);
  if (state?.allowsConsequential !== undefined) {
    return state.allowsConsequential;
  }
  return stateId === contract.preconditionStateId;
}
