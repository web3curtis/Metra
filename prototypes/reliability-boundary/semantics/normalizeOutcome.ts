/**
 * C1 — complete outcome normalization for sync/async/throw/timeout/cancel/malformed paths.
 */

import {
  buildStructuredFailure,
  envelopeFromToolError,
  type StructuredFailure,
} from "./structuredFailure.ts";

export type OutcomeKind =
  | "success"
  | "tool_error"
  | "thrown"
  | "rejected"
  | "timeout"
  | "cancelled"
  | "malformed_success"
  | "partial";

export type NormalizedOutcome = {
  kind: OutcomeKind;
  ok: boolean;
  tool: string;
  state_revision: number;
  operation_id?: string;
  raw_preserved: unknown;
  missing_evidence: string[];
  structured_failure: StructuredFailure | null;
  commit_status: "none" | "committed" | "possible" | "rejected";
  authority: "authoritative" | "client_only" | "unavailable";
};

export function normalizeOutcome(input: {
  tool: string;
  state: string;
  state_revision: number;
  operation_id?: string;
  kind: OutcomeKind;
  value?: unknown;
  error?: unknown;
  malformed?: boolean;
}): NormalizedOutcome {
  const raw_preserved =
    input.error !== undefined
      ? { error: safeRaw(input.error) }
      : { value: safeRaw(input.value) };

  if (input.kind === "success" && input.malformed) {
    const sf = buildStructuredFailure({
      category: "malformed_success",
      tool: input.tool,
      expected: "complete_postconditions",
      actual: "malformed_or_partial_success",
      owner: "reliability_boundary",
      recoverability: "non_recoverable",
      state_revision: input.state_revision,
      operation_id: input.operation_id,
      evidence: ["normalizeOutcome:malformed_success"],
    });
    return {
      kind: "malformed_success",
      ok: false,
      tool: input.tool,
      state_revision: input.state_revision,
      operation_id: input.operation_id,
      raw_preserved,
      missing_evidence: ["postcondition_fields"],
      structured_failure: sf,
      commit_status: "possible",
      authority: "unavailable",
    };
  }

  if (input.kind === "success") {
    return {
      kind: "success",
      ok: true,
      tool: input.tool,
      state_revision: input.state_revision,
      operation_id: input.operation_id,
      raw_preserved,
      missing_evidence: [],
      structured_failure: null,
      commit_status: "committed",
      authority: "authoritative",
    };
  }

  if (input.kind === "partial") {
    const sf = buildStructuredFailure({
      category: "execution_error",
      tool: input.tool,
      expected: "complete_result",
      actual: "partial_result",
      owner: "website",
      recoverability: "automatic",
      state_revision: input.state_revision,
      operation_id: input.operation_id,
      evidence: ["normalizeOutcome:partial"],
    });
    return {
      kind: "partial",
      ok: false,
      tool: input.tool,
      state_revision: input.state_revision,
      operation_id: input.operation_id,
      raw_preserved,
      missing_evidence: ["remaining_fields"],
      structured_failure: sf,
      commit_status: "possible",
      authority: "client_only",
    };
  }

  const errorString =
    typeof input.error === "string"
      ? input.error
      : input.error instanceof Error
        ? input.error.message || "Error"
        : input.kind === "timeout"
          ? "timeout"
          : input.kind === "cancelled"
            ? "cancelled"
            : input.kind === "rejected"
              ? "rejected"
              : "Error";

  const mappedKind: OutcomeKind =
    input.kind === "thrown" ||
    input.kind === "rejected" ||
    input.kind === "timeout" ||
    input.kind === "cancelled" ||
    input.kind === "tool_error"
      ? input.kind
      : "tool_error";

  let sf: StructuredFailure;
  if (mappedKind === "timeout" || mappedKind === "cancelled") {
    sf = buildStructuredFailure({
      category: "ambiguous_commit",
      tool: input.tool,
      expected: "authoritative_commit_status",
      actual: mappedKind,
      owner: "network",
      recoverability: "automatic",
      state_revision: input.state_revision,
      operation_id: input.operation_id,
      evidence: [`normalizeOutcome:${mappedKind}`, "raw_preserved"],
    });
  } else if (mappedKind === "thrown" || mappedKind === "rejected") {
    sf = envelopeFromToolError({
      tool: input.tool,
      error: errorString,
      state: input.state,
      state_revision: input.state_revision,
      operation_id: input.operation_id,
    });
    sf = {
      ...sf,
      evidence: [...sf.evidence, `normalizeOutcome:${mappedKind}`, "raw_preserved"],
    };
  } else {
    sf = envelopeFromToolError({
      tool: input.tool,
      error: errorString,
      state: input.state,
      state_revision: input.state_revision,
      operation_id: input.operation_id,
    });
    sf = { ...sf, evidence: [...sf.evidence, "normalizeOutcome:tool_error", "raw_preserved"] };
  }

  return {
    kind: mappedKind,
    ok: false,
    tool: input.tool,
    state_revision: input.state_revision,
    operation_id: input.operation_id,
    raw_preserved,
    missing_evidence: sf.category === "ambiguous_commit" ? ["authoritative_commit_lookup"] : [],
    structured_failure: sf,
    commit_status: sf.category === "ambiguous_commit" ? "possible" : "rejected",
    authority: sf.category === "ambiguous_commit" ? "unavailable" : "client_only",
  };
}

function safeRaw(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}
