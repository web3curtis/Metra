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
  operation_id?: string;
}): StructuredFailure {
  if (input.error === "contract_violation" || input.error === "contract_output_violation") {
    return buildStructuredFailure({
      category: "invalid_input_or_precondition",
      tool: input.tool,
      expected: "contract_ok",
      actual: input.state,
      owner: "reliability_boundary",
      recoverability: "non_recoverable",
      state_revision: input.state_revision,
      operation_id: input.operation_id,
      evidence: ["contract_validate"],
    });
  }
  if (input.error === "stale_capability_epoch" || input.error === "stale_dependency" || input.error === "missing_epoch") {
    return buildStructuredFailure({
      category: "stale_observation_or_capability",
      tool: input.tool,
      expected: "fresh_dependencies",
      actual: input.error,
      owner: "reliability_boundary",
      recoverability: "automatic",
      state_revision: input.state_revision,
      operation_id: input.operation_id,
      evidence: ["freshness_evaluate"],
    });
  }
  if (
    input.error === "purchase_timeout_unknown" ||
    input.error === "Error" ||
    input.error === "timeout" ||
    input.error.includes("timeout")
  ) {
    return buildStructuredFailure({
      category: "ambiguous_commit",
      tool: input.tool,
      expected: "authoritative_commit_status",
      actual: "client_timeout_or_opaque_error",
      owner: "network",
      recoverability: "automatic",
      state_revision: input.state_revision,
      operation_id: input.operation_id,
      evidence: ["raw_timeout_or_opaque", "effect_may_have_committed"],
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
    operation_id: input.operation_id,
    evidence: ["raw_tool_error"],
  });
}
