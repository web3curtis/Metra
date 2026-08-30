import type { ScenarioContract } from "../scenarioContract.ts";

/** DocuFlow — publish a reviewed document (synthetic portability fixture). */
export const DOCUFLOW_FIXTURE: ScenarioContract = {
  id: "docuflow-v0",
  label: "DocuFlow document publishing",
  version: "0.1.0",
  consequentialTool: "publish_document",
  tools: ["create_draft", "submit_for_review", "approve_document", "publish_document"],
  states: [
    { id: "DRAFT", label: "Draft" },
    { id: "IN_REVIEW", label: "In review" },
    { id: "APPROVED", label: "Approved", allowsConsequential: true },
    { id: "PUBLISHED", label: "Published" },
  ],
  initialStateId: "DRAFT",
  preconditionStateId: "APPROVED",
  oracleHooks: [
    {
      id: "review_before_publish",
      description: "Publish blocked until document is APPROVED",
      adversityKey: "wrong_precondition_state",
    },
    {
      id: "single_publish",
      description: "At most one publish commit per document revision",
      adversityKey: "ambiguous_commit_after_timeout",
    },
    {
      id: "catalog_freshness",
      description: "Stale doc tool catalog rejects publish",
      adversityKey: "stale_capability_epoch",
    },
  ],
};
