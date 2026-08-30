import type { ScenarioContract } from "../scenarioContract.ts";

/** WorkBoard — create and transition issues (synthetic portability fixture). */
export const WORKBOARD_FIXTURE: ScenarioContract = {
  id: "workboard-v0",
  label: "WorkBoard issue tracker",
  version: "0.1.0",
  consequentialTool: "transition_issue",
  tools: ["create_issue", "assign_issue", "transition_issue", "list_issues"],
  states: [
    { id: "BACKLOG", label: "Backlog" },
    { id: "IN_PROGRESS", label: "In progress" },
    { id: "IN_REVIEW", label: "In review", allowsConsequential: true },
    { id: "DONE", label: "Done" },
  ],
  initialStateId: "BACKLOG",
  preconditionStateId: "IN_REVIEW",
  oracleHooks: [
    {
      id: "create_then_transition",
      description: "Issue must exist before transition to DONE",
      adversityKey: "missing_issue_id",
    },
    {
      id: "no_double_done",
      description: "Second transition to DONE is rejected",
      adversityKey: "duplicate_transition",
    },
    {
      id: "stale_board_epoch",
      description: "Board tool set change invalidates in-flight transition",
      adversityKey: "stale_capability_epoch",
    },
  ],
};
