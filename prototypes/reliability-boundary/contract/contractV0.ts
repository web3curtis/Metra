/**
 * A — Direction-bearing behavioral contract (declarative registry + neutral engine).
 * Policy core branches on contract fields, not domain nouns.
 */

import type { ProtocolRunContext } from "../spine/protocolSpine.ts";

export type EffectClass =
  | "read"
  | "draft_mutation"
  | "consequential_mutation"
  | "externally_consequential";

export type ContractViolation = {
  code: string;
  field?: string;
  message: string;
};

export type ToolContract = {
  tool_id: string;
  contract_version: string;
  purpose: string;
  effect_class: EffectClass;
  required_args: string[];
  required_states?: string[];
  forbidden_states?: string[];
  requires_confirmation?: boolean;
  freshness_dependencies: Array<"capability_epoch" | "document_epoch" | "session_epoch" | "state_revision">;
  expected_transition?: { from?: string[]; to?: string[] };
  postconditions?: Array<"order_id" | "receipt_id" | "operation_id" | "revision_advanced">;
  failure_categories: string[];
  retry_safe: boolean;
  unknown_field_policy: "reject" | "ignore";
};

export type CallValidationInput = {
  tool: string;
  args: Record<string, unknown>;
  state: string;
  currency?: string;
  budget_aud?: number;
  passenger_count?: number;
  contract?: ToolContract;
  protocol?: ProtocolRunContext;
};

export type CallValidationResult = {
  ok: boolean;
  violations: ContractViolation[];
  contract_version?: string;
  effect_class?: EffectClass;
};

export type OutputValidationInput = {
  tool: string;
  ok: boolean;
  data?: unknown;
  contract?: ToolContract;
  state_before?: string;
  state_after?: string;
};

const DEFAULT_FAILURES = [
  "invalid_input_or_precondition",
  "stale_capability_or_state",
  "execution_failure",
  "ambiguous_effect",
  "malformed_success",
];

/** Declarative contracts for ReliableRail registered tools. */
export const RELIABLE_RAIL_CONTRACTS: Record<string, ToolContract> = {
  search_journeys: {
    tool_id: "search_journeys",
    contract_version: "a-v1",
    purpose: "Observe available journeys for planning",
    effect_class: "read",
    required_args: [],
    freshness_dependencies: ["capability_epoch"],
    failure_categories: DEFAULT_FAILURES,
    retry_safe: true,
    unknown_field_policy: "ignore",
  },
  select_journey: {
    tool_id: "select_journey",
    contract_version: "a-v1",
    purpose: "Bind outbound/return journeys into the draft",
    effect_class: "draft_mutation",
    required_args: ["outbound_journey_id", "return_journey_id"],
    freshness_dependencies: ["capability_epoch", "state_revision"],
    expected_transition: { to: ["JOURNEY_SELECTED", "SEATS_RESERVED", "ORDER_REVIEWED", "PURCHASED"] },
    failure_categories: DEFAULT_FAILURES,
    retry_safe: true,
    unknown_field_policy: "reject",
  },
  list_available_seats: {
    tool_id: "list_available_seats",
    contract_version: "a-v1",
    purpose: "Observe seat inventory for the draft",
    effect_class: "read",
    required_args: [],
    freshness_dependencies: ["capability_epoch", "state_revision"],
    failure_categories: DEFAULT_FAILURES,
    retry_safe: true,
    unknown_field_policy: "ignore",
  },
  reserve_seats: {
    tool_id: "reserve_seats",
    contract_version: "a-v1",
    purpose: "Reserve seats for passengers in the draft",
    effect_class: "draft_mutation",
    required_args: ["seat_ids"],
    freshness_dependencies: ["capability_epoch", "state_revision"],
    failure_categories: DEFAULT_FAILURES,
    retry_safe: false,
    unknown_field_policy: "reject",
  },
  review_order: {
    tool_id: "review_order",
    contract_version: "a-v1",
    purpose: "Review draft totals and budget before purchase",
    effect_class: "draft_mutation",
    required_args: [],
    freshness_dependencies: ["state_revision"],
    expected_transition: { to: ["ORDER_REVIEWED", "PURCHASED"] },
    failure_categories: DEFAULT_FAILURES,
    retry_safe: true,
    unknown_field_policy: "ignore",
  },
  purchase_tickets: {
    tool_id: "purchase_tickets",
    contract_version: "a-v1",
    purpose: "Commit one simulated purchase against reviewed draft",
    effect_class: "consequential_mutation",
    required_args: [],
    required_states: ["ORDER_REVIEWED"],
    requires_confirmation: true,
    freshness_dependencies: ["capability_epoch", "document_epoch", "state_revision"],
    expected_transition: { from: ["ORDER_REVIEWED"], to: ["PURCHASED"] },
    postconditions: ["order_id", "receipt_id"],
    failure_categories: DEFAULT_FAILURES,
    retry_safe: false,
    unknown_field_policy: "reject",
  },
  get_order: {
    tool_id: "get_order",
    contract_version: "a-v1",
    purpose: "Read authoritative order state for reconcile/verify",
    effect_class: "read",
    required_args: [],
    freshness_dependencies: ["state_revision"],
    failure_categories: DEFAULT_FAILURES,
    retry_safe: true,
    unknown_field_policy: "ignore",
  },
  cancel_draft: {
    tool_id: "cancel_draft",
    contract_version: "a-v1",
    purpose: "Cancel an uncommitted draft",
    effect_class: "draft_mutation",
    required_args: [],
    forbidden_states: ["PURCHASED"],
    freshness_dependencies: ["state_revision"],
    failure_categories: DEFAULT_FAILURES,
    retry_safe: true,
    unknown_field_policy: "ignore",
  },
  reset_fixture: {
    tool_id: "reset_fixture",
    contract_version: "a-v1",
    purpose: "Harness reset only",
    effect_class: "draft_mutation",
    required_args: [],
    freshness_dependencies: [],
    failure_categories: DEFAULT_FAILURES,
    retry_safe: true,
    unknown_field_policy: "ignore",
  },
};

export function getToolContract(tool: string): ToolContract | undefined {
  return RELIABLE_RAIL_CONTRACTS[tool];
}

/** Neutral engine: validates against a ToolContract object, not tool-name switches. */
export function validateAgainstContract(
  contract: ToolContract,
  input: Omit<CallValidationInput, "contract">,
): CallValidationResult {
  const violations: ContractViolation[] = [];

  for (const field of contract.required_args) {
    const value = input.args[field];
    if (value === undefined || value === null || value === "") {
      violations.push({ code: "required_field", field, message: `${field} required` });
    }
  }

  if (contract.unknown_field_policy === "reject") {
    const allowed = new Set([
      ...contract.required_args,
      "operation_id",
      "expected_revision",
      "origin",
      "destination",
      "direction",
    ]);
    for (const key of Object.keys(input.args)) {
      if (!allowed.has(key)) {
        violations.push({ code: "unknown_field", field: key, message: `unknown field ${key}` });
      }
    }
  }

  if (contract.required_states && !contract.required_states.includes(input.state)) {
    violations.push({
      code: "precondition_state",
      field: "state",
      message: `required state not satisfied`,
    });
  }

  if (contract.forbidden_states?.includes(input.state)) {
    violations.push({
      code: "precondition_state",
      field: "state",
      message: `forbidden state`,
    });
  }

  // Generic semantic constraint: when passenger_count is supplied and seat_ids present, lengths must match.
  if (input.passenger_count !== undefined && Array.isArray(input.args.seat_ids)) {
    if (input.args.seat_ids.length !== input.passenger_count) {
      violations.push({
        code: "constraint",
        field: "seat_ids",
        message: `expected ${input.passenger_count} seats`,
      });
    }
  }

  if (input.currency && input.currency !== "AUD") {
    violations.push({
      code: "constraint",
      field: "currency",
      message: "currency must match fixture authority",
    });
  }

  if (input.protocol) {
    input.protocol.record({
      component: "spine",
      stage: "contract",
      event_type: "contract_validate",
      payload: {
        tool: contract.tool_id,
        contract_version: contract.contract_version,
        effect_class: contract.effect_class,
        ok: violations.length === 0,
        violation_codes: violations.map((v) => v.code),
      },
    });
  }

  return {
    ok: violations.length === 0,
    violations,
    contract_version: contract.contract_version,
    effect_class: contract.effect_class,
  };
}

/** Back-compat entry used by harness: resolve declarative contract then run neutral engine. */
export function validateCall(input: CallValidationInput): CallValidationResult {
  const contract = input.contract ?? getToolContract(input.tool);
  if (!contract) {
    return {
      ok: false,
      violations: [
        {
          code: "missing_contract",
          message: `no declarative contract registered for tool`,
        },
      ],
    };
  }
  return validateAgainstContract(contract, input);
}

export function validateOutput(input: OutputValidationInput): CallValidationResult {
  const violations: ContractViolation[] = [];
  const contract = input.contract ?? getToolContract(input.tool);
  if (!contract) {
    return { ok: true, violations: [] };
  }

  if (input.ok && contract.postconditions) {
    const data = (input.data ?? {}) as Record<string, unknown>;
    for (const pc of contract.postconditions) {
      if (pc === "order_id" && !data.order_id) {
        violations.push({ code: "malformed_success", field: "order_id", message: "missing order_id" });
      }
      if (pc === "receipt_id" && !data.receipt_id) {
        violations.push({ code: "malformed_success", field: "receipt_id", message: "missing receipt_id" });
      }
      if (pc === "operation_id" && !data.operation_id) {
        violations.push({
          code: "malformed_success",
          field: "operation_id",
          message: "missing operation_id",
        });
      }
    }
  }

  if (
    input.ok &&
    contract.expected_transition?.to &&
    input.state_after &&
    !contract.expected_transition.to.includes(input.state_after)
  ) {
    violations.push({
      code: "transition_mismatch",
      field: "state",
      message: `expected transition to one of [${contract.expected_transition.to.join(",")}]`,
    });
  }

  // Malformed success must not remain agent-visible success.
  if (input.ok && violations.length > 0) {
    return {
      ok: false,
      violations,
      contract_version: contract.contract_version,
      effect_class: contract.effect_class,
    };
  }

  return {
    ok: violations.length === 0,
    violations,
    contract_version: contract.contract_version,
    effect_class: contract.effect_class,
  };
}
