import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventRecorder, invokeTool } from "../src/domain/harness.ts";
import { ReliableRailStore } from "../src/domain/store.ts";
import type { Fixture } from "../src/domain/types.ts";
import { exactStageFlags } from "../src/adversity/adversityEngine.ts";
import {
  allowConsequentialCall,
  applyDiagnosisDecision,
  createDiagnosisGate,
} from "../../reliability-boundary/diagnosis/diagnosisExecutor.ts";
import { selectDiagnosisAction } from "../../reliability-boundary/diagnosis/diagnosisPolicy.ts";
import { envelopeFromToolError } from "../../reliability-boundary/semantics/structuredFailure.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "../../../configurations/fixtures/fixture-v0.json"), "utf8"),
) as Fixture;

describe("B exact-stage (A+B only) stale → reobserve → one purchase", () => {
  it("rejects stale, then succeeds after epoch refresh without C1/C2", () => {
    const flags = exactStageFlags("B");
    expect(flags.structured_semantics).toBe(false);
    expect(flags.diagnosis_policy).toBe(false);

    const store = new ReliableRailStore(fixture);
    const rec = new EventRecorder();
    prepReviewed(store, rec);

    const stale = invokeTool(store, rec, "purchase_tickets", {}, "b", {
      contractConformance: flags.contract_conformance,
      capabilityFreshness: flags.capability_freshness,
      expectedCapabilityEpoch: "epoch:ui",
      actualCapabilityEpoch: "epoch:changed",
    });
    expect(stale.ok).toBe(false);
    expect(stale.error).toBe("stale_capability_epoch");
    expect(store.getOrder().committed_purchase_count).toBe(0);

    // B-only playbook: map stale → reobserve (refresh expected epoch)
    const ok = invokeTool(store, rec, "purchase_tickets", {}, "b", {
      contractConformance: flags.contract_conformance,
      capabilityFreshness: flags.capability_freshness,
      expectedCapabilityEpoch: "epoch:changed",
      actualCapabilityEpoch: "epoch:changed",
    });
    expect(ok.ok).toBe(true);
    expect(store.getOrder().committed_purchase_count).toBe(1);
  });
});

describe("C2 diagnosis executor enforces stop/reconcile/reobserve", () => {
  it("blocks consequential after stop", () => {
    let gate = createDiagnosisGate();
    const env = envelopeFromToolError({
      tool: "purchase_tickets",
      error: "contract_violation",
      state: "EMPTY",
      state_revision: 0,
    });
    const decision = selectDiagnosisAction({ structuredFailure: env });
    gate = applyDiagnosisDecision(gate, decision);
    expect(gate.consequential_blocked).toBe(true);
    expect(allowConsequentialCall(gate).ok).toBe(false);
  });

  it("requires reconcile before retry after ambiguous commit", () => {
    let gate = createDiagnosisGate();
    const env = envelopeFromToolError({
      tool: "purchase_tickets",
      error: "purchase_timeout_unknown",
      state: "PURCHASED",
      state_revision: 1,
    });
    gate = applyDiagnosisDecision(gate, selectDiagnosisAction({ structuredFailure: env }));
    expect(allowConsequentialCall(gate).ok).toBe(false);
    expect(allowConsequentialCall(gate, { reconciled: true }).ok).toBe(true);
  });
});

function prepReviewed(store: ReliableRailStore, rec: EventRecorder) {
  invokeTool(store, rec, "reset_fixture", {}, "prep");
  invokeTool(
    store,
    rec,
    "select_journey",
    {
      outbound_journey_id: fixture.task_target.outbound_journey_id,
      return_journey_id: fixture.task_target.return_journey_id,
    },
    "prep",
  );
  invokeTool(store, rec, "reserve_seats", { seat_ids: fixture.default_adjacent_pair }, "prep");
  invokeTool(store, rec, "review_order", {}, "prep");
}
