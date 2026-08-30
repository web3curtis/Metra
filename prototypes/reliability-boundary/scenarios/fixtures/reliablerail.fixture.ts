import type { ScenarioContract } from "../scenarioContract.ts";

/**
 * ReliableRail reference descriptor — adapter and store live outside this core package.
 * Fixture path is informational; no runtime load from scenarios/.
 */
export const RELIABLERAIL_FIXTURE: ScenarioContract = {
  id: "reliablerail-v0",
  label: "ReliableRail Sydney–Canberra train tickets",
  version: "0.1.0",
  consequentialTool: "purchase_tickets",
  tools: [
    "search_journeys",
    "select_journey",
    "reserve_seats",
    "review_order",
    "purchase_tickets",
  ],
  states: [
    { id: "EMPTY", label: "No selection" },
    { id: "JOURNEYS_SELECTED", label: "Journeys chosen" },
    { id: "SEATS_RESERVED", label: "Seats held" },
    { id: "ORDER_REVIEWED", label: "Order reviewed", allowsConsequential: true },
    { id: "PURCHASED", label: "Purchase committed" },
  ],
  initialStateId: "EMPTY",
  preconditionStateId: "ORDER_REVIEWED",
  oracleHooks: [
    {
      id: "single_commit",
      description: "At most one committed purchase per session",
      adversityKey: "ambiguous_commit_after_timeout",
    },
    {
      id: "contract_gate",
      description: "Consequential call blocked outside ORDER_REVIEWED",
      adversityKey: "wrong_precondition_state",
    },
    {
      id: "freshness_gate",
      description: "Stale capability epoch rejects consequential tool",
      adversityKey: "stale_capability_epoch",
    },
  ],
  externalFixtureRef: {
    adapterId: "reliablerail-adapter",
    fixturePath: "configurations/fixtures/fixture-v0.json",
  },
};
