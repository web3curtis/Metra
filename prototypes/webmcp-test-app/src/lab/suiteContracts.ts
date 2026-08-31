/**
 * A — machine-enforced contract registry for every registered WebMCP tool.
 *
 * The registry is derived from declarative catalog data. The enforcement engine in
 * `enforcedRuntime.ts` branches only on the fields below, never on domain nouns, so
 * surface-different variations share one policy core.
 */

import type { ToolContract } from "../../../reliability-boundary/contract/contractV0.ts";
import type {
  FreshnessDependency,
  LabTool,
  RetryPolicy,
  ToolRole,
  UseCase,
} from "./catalog.ts";
import { USE_CASES } from "./catalog.ts";

export const SUITE_CONTRACT_VERSION = "suite-a-v2";

export type SuiteToolContract = {
  tool_id: string;
  use_case_id: string;
  tool_name: string;
  contract_version: string;
  role: ToolRole;
  purpose: string;
  /** Neutral A-engine contract used for argument/shape validation. */
  shape: ToolContract;
  /** Verified-observation keys that must be current before dispatch. */
  required_states: string[];
  /** Verified-observation key recorded when this tool succeeds. */
  produces_state: string | null;
  /** Dependencies that invalidate this tool's observation and its dispatch. */
  freshness_dependencies: FreshnessDependency[];
  /** Fields that must be present in a successful result. */
  postconditions: string[];
  expected_transition: { from: string[]; to: string[] };
  retry_policy: RetryPolicy;
  /** Single legal next action offered when this tool is blocked. */
  blocked_next_action: "observe" | "reconcile" | "stop";
  /**
   * How many confirmed effects this tool may produce in one session. Every task in
   * this suite asks for exactly one, so the limit is declared and enforced rather
   * than left to depend on when the verify-before-acting gate happens to clear.
   */
  effect_budget: number | null;
};

const FAILURE_CATEGORIES = [
  "invalid_input_or_precondition",
  "stale_capability_or_state",
  "execution_failure",
  "ambiguous_effect",
  "malformed_success",
];

function shapeContract(useCase: UseCase, tool: LabTool, tool_id: string): ToolContract {
  const required_args =
    tool.role === "act"
      ? ["operation_id", "expected_revision"]
      : tool.role === "reconcile"
        ? ["operation_id"]
        : [];
  return {
    tool_id,
    contract_version: SUITE_CONTRACT_VERSION,
    purpose: tool.description,
    effect_class: tool.readOnly ? "read" : "consequential_mutation",
    required_args,
    requires_confirmation: tool.role === "act",
    freshness_dependencies: tool.freshness,
    postconditions: [],
    expected_transition:
      tool.role === "act" ? { from: ["READY"], to: [useCase.committedState] } : undefined,
    failure_categories: FAILURE_CATEGORIES,
    retry_safe: tool.retryPolicy === "idempotent_read",
    unknown_field_policy: tool.readOnly ? "ignore" : "reject",
  };
}

export function suiteToolContracts(): Record<string, SuiteToolContract> {
  const out: Record<string, SuiteToolContract> = {};
  for (const useCase of USE_CASES) {
    for (const tool of useCase.tools) {
      const tool_id = `${useCase.id}.${tool.name}`;
      out[tool_id] = {
        tool_id,
        use_case_id: useCase.id,
        tool_name: tool.name,
        contract_version: SUITE_CONTRACT_VERSION,
        role: tool.role,
        purpose: tool.description,
        shape: shapeContract(useCase, tool, tool_id),
        required_states: tool.requiresEvidence ?? [],
        produces_state: tool.producesEvidence ?? null,
        freshness_dependencies: tool.freshness,
        postconditions: tool.postconditions,
        expected_transition:
          tool.role === "act"
            ? { from: ["READY"], to: [useCase.committedState] }
            : { from: [], to: [] },
        retry_policy: tool.retryPolicy,
        blocked_next_action:
          tool.role === "act" ? "observe" : tool.role === "reconcile" ? "reconcile" : "stop",
        effect_budget: tool.role === "act" ? 1 : null,
      };
    }
  }
  return out;
}

const REGISTRY = suiteToolContracts();

export function getSuiteToolContract(tool_id: string): SuiteToolContract | undefined {
  return REGISTRY[tool_id];
}

/**
 * Which registered tool produces a required observation. Used to name the single
 * legal next action when a consequential call is blocked on missing evidence.
 */
export function producerOf(use_case_id: string, state: string): string | null {
  for (const contract of Object.values(REGISTRY)) {
    if (contract.use_case_id === use_case_id && contract.produces_state === state) {
      return contract.tool_id;
    }
  }
  return null;
}
