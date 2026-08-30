import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventRecorder, invokeTool } from "../src/domain/harness.ts";
import { ReliableRailStore } from "../src/domain/store.ts";
import type { Fixture } from "../src/domain/types.ts";
import { exactStageFlags } from "../src/adversity/adversityEngine.ts";
import type { EffectRecord } from "../../reliability-boundary/effect/effectSafety.ts";
import { decideRecovery } from "../../reliability-boundary/recovery/stateRecovery.ts";
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

describe("D1 exact-stage timeout → reconcile → ≤1 commit", () => {
  it("with D1 flags: timeout then get_order(op) then no second commit", () => {
    const flags = exactStageFlags("D1");
    const store = new ReliableRailStore(fixture);
    const rec = new EventRecorder();
    const registry = new Map<string, EffectRecord>();
    prep(store, rec);

    const purchase = invokeTool(
      store,
      rec,
      "purchase_tickets",
      { operation_id: "op_d1" },
      "d1",
      {
        ...toInvoke(flags),
        effectRegistry: registry,
        simulateClientTimeoutAfterCommit: true,
        expectedCapabilityEpoch: "e",
        actualCapabilityEpoch: "e",
      },
    );
    expect(purchase.ok).toBe(false);
    expect(purchase.error).toBe("purchase_timeout_unknown");
    expect(store.getOrder().committed_purchase_count).toBe(1);

    const got = invokeTool(store, rec, "get_order", { operation_id: "op_d1" }, "d1", {
      ...toInvoke(flags),
      effectRegistry: registry,
      expectedCapabilityEpoch: "e",
      actualCapabilityEpoch: "e",
    });
    expect(got.ok).toBe(true);
    const recon = (got.data as { reconciliation: { action: string } }).reconciliation;
    expect(recon.action).toMatch(/reuse|already|commit|confirm/i);

    const retry = invokeTool(
      store,
      rec,
      "purchase_tickets",
      { operation_id: "op_d1" },
      "d1",
      {
        ...toInvoke(flags),
        effectRegistry: registry,
        expectedCapabilityEpoch: "e",
        actualCapabilityEpoch: "e",
      },
    );
    expect(retry.ok).toBe(false);
    expect(store.getOrder().committed_purchase_count).toBe(1);
  });
});

describe("D2 recovery enforces stop after purchased hydrate", () => {
  it("decideRecovery stop and gate blocks second purchase", () => {
    const store = new ReliableRailStore(fixture);
    const rec = new EventRecorder();
    prep(store, rec);
    invokeTool(store, rec, "purchase_tickets", {}, "d2");
    const order = store.getOrder();
    const decision = decideRecovery({
      tools_include_purchase: true,
      order_state: order.state,
      order_id: order.order_id,
      receipt_id: order.receipt_id,
      total_aud: order.total_aud,
      budget_aud: fixture.budget_aud,
      seat_ids: order.seat_ids,
      price_drift: false,
      seat_drift: false,
    });
    expect(decision.action).toBe("stop");

    // Simulate UI gate: stop means no second purchase
    expect(order.committed_purchase_count).toBe(1);
    const dup = invokeTool(store, rec, "purchase_tickets", {}, "d2");
    expect(dup.ok).toBe(false);
    expect(store.getOrder().committed_purchase_count).toBe(1);
  });
});

describe("C2 all four diagnosis actions selectable", () => {
  it("maps categories to reobserve reconcile stop escalate", () => {
    const cases: Array<{ error: string; action: string }> = [
      { error: "stale_capability_epoch", action: "reobserve" },
      { error: "purchase_timeout_unknown", action: "reconcile" },
      { error: "contract_violation", action: "stop" },
    ];
    for (const c of cases) {
      const env = envelopeFromToolError({
        tool: "purchase_tickets",
        error: c.error,
        state: "ORDER_REVIEWED",
        state_revision: 1,
      });
      expect(selectDiagnosisAction({ structuredFailure: env }).action).toBe(c.action);
    }
    const escalateEnv = envelopeFromToolError({
      tool: "purchase_tickets",
      error: "provider_500",
      state: "ORDER_REVIEWED",
      state_revision: 1,
    });
    expect(selectDiagnosisAction({ structuredFailure: escalateEnv }).action).toBe("escalate");

    let gate = createDiagnosisGate();
    gate = applyDiagnosisDecision(
      gate,
      selectDiagnosisAction({ structuredFailure: escalateEnv }),
    );
    expect(allowConsequentialCall(gate).ok).toBe(false);
  });
});

function toInvoke(flags: ReturnType<typeof exactStageFlags>) {
  return {
    contractConformance: flags.contract_conformance,
    capabilityFreshness: flags.capability_freshness,
    structuredSemantics: flags.structured_semantics,
    diagnosisPolicy: flags.diagnosis_policy,
    effectSafety: flags.effect_safety,
  };
}

function prep(store: ReliableRailStore, rec: EventRecorder) {
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
