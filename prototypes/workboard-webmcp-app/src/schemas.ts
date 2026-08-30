/** Concrete schemas + shared types (required fields explicit). */
export const TOOL_INPUT_SCHEMAS: Record<string, object> = {
  list_projects: { type: "object", properties: {}, additionalProperties: false },
  create_issue: {
    type: "object", required: ["title"],
    properties: { title: { type: "string", minLength: 1 }, project_id: { type: "string" } },
    additionalProperties: false,
  },
  transition_issue: {
    type: "object", required: ["issue_id", "to_state"],
    properties: {
      issue_id: { type: "string" },
      to_state: { type: "string", enum: ["BACKLOG", "IN_PROGRESS", "IN_REVIEW", "DONE"] },
      operation_id: { type: "string" },
    },
    additionalProperties: false,
  },
};

export type ToolName = "list_projects" | "create_issue" | "transition_issue";
export type ToolResult = { ok: boolean; data?: unknown; error?: string };
export type MechanismFlags = Record<
  "contract_conformance" | "capability_freshness" | "structured_semantics" |
  "diagnosis_policy" | "effect_safety" | "state_recovery", boolean
>;
export type AdversityId = "none" | "capability_change" | "opaque_failure" | "client_timeout_after_commit" | "reload";
export const DEFAULT_FLAGS: MechanismFlags = {
  contract_conformance: false, capability_freshness: false, structured_semantics: false,
  diagnosis_policy: false, effect_safety: false, state_recovery: false,
};
