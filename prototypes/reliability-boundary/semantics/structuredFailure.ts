export type FailureOwner =
  | "webmcp"
  | "browser"
  | "website"
  | "agent"
  | "network"
  | "session"
  | "reliability_boundary"
  | "evaluator"
  | "unknown";

export type Recoverability =
  | "automatic"
  | "manager"
  | "user"
  | "non_recoverable"
  | "unknown";

export type StructuredFailure = {
  category: string;
  tool: string;
  expected: string;
  actual: string;
  owner: FailureOwner;
  recoverability: Recoverability;
  state_revision: number;
  operation_id?: string;
  evidence: string[];
};

export function buildStructuredFailure(input: {
  category: string;
  tool: string;
  expected: string;
  actual: string;
  owner?: FailureOwner;
  recoverability?: Recoverability;
  state_revision: number;
  operation_id?: string;
  evidence?: string[];
}): StructuredFailure {
  return {
    category: input.category,
    tool: input.tool,
    expected: input.expected,
    actual: input.actual,
    owner: input.owner ?? "unknown",
    recoverability: input.recoverability ?? "unknown",
    state_revision: input.state_revision,
    operation_id: input.operation_id,
    evidence: input.evidence ?? [],
  };
}

export function envelopeFromToolError(input: {
  tool: string;
  error: string;
  state: string;
  state_revision: number;
}): StructuredFailure {
  if (input.error === "contract_violation") {
    return buildStructuredFailure({
      category: "invalid_input_or_precondition",
      tool: input.tool,
      expected: "ORDER_REVIEWED_and_contract_ok",
      actual: input.state,
      owner: "reliability_boundary",
      recoverability: "non_recoverable",
      state_revision: input.state_revision,
      evidence: ["contract_v0_validateCall"],
    });
  }
  if (input.error === "stale_capability_epoch") {
    return buildStructuredFailure({
      category: "stale_observation_or_capability",
      tool: input.tool,
      expected: "matching_capability_epoch",
      actual: "epoch_mismatch",
      owner: "reliability_boundary",
      recoverability: "automatic",
      state_revision: input.state_revision,
      evidence: ["capability_freshness_rejectStaleConsequential", "required_action:reobserve"],
    });
  }
  if (
    input.error === "purchase_timeout_unknown" ||
    input.error === "ambiguous_commit"
  ) {
    return buildStructuredFailure({
      category: "ambiguous_commit",
      tool: input.tool,
      expected: "confirmed_commit_or_absent",
      actual: input.error,
      owner: "session",
      recoverability: "automatic",
      state_revision: input.state_revision,
      evidence: ["client_timeout_after_possible_commit", "required_action:reconcile"],
    });
  }
  return buildStructuredFailure({
    category: "execution_error",
    tool: input.tool,
    expected: "ok",
    actual: input.error,
    owner: "unknown",
    recoverability: "unknown",
    state_revision: input.state_revision,
    evidence: ["raw_tool_error"],
  });
}
