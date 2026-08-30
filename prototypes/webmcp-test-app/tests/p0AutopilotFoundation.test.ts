import { describe, expect, it } from "vitest";
import {
  assertExactFlags,
  assertMatchedAdversity,
  createAdversityReceipt,
  exactStageFlags,
} from "../src/adversity/adversityEngine.ts";
import { TOOL_INPUT_SCHEMAS } from "../src/webmcp/toolSchemas.ts";
import { normalizeHandlerResult } from "../src/webmcp/register.ts";
import { EventRecorder, invokeTool } from "../src/domain/harness.ts";
import { ReliableRailStore } from "../src/domain/store.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Fixture } from "../src/domain/types.ts";
import { envelopeFromToolError } from "../../reliability-boundary/semantics/structuredFailure.ts";
import { selectDiagnosisAction } from "../../reliability-boundary/diagnosis/diagnosisPolicy.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "../../../configurations/fixtures/fixture-v0.json"), "utf8"),
) as Fixture;

describe("P0 adversity engine", () => {
  it("matches identical control/treatment receipts", () => {
    const c = createAdversityReceipt({
      adversity_id: "opaque_failure",
      arm: "control",
    });
    const t = createAdversityReceipt({
      adversity_id: "opaque_failure",
      arm: "treatment",
    });
    expect(assertMatchedAdversity(c, t).ok).toBe(true);
  });

  it("invalidates mismatched adversity", () => {
    const c = createAdversityReceipt({ adversity_id: "none", arm: "control" });
    const t = createAdversityReceipt({
      adversity_id: "capability_change",
      arm: "treatment",
    });
    expect(assertMatchedAdversity(c, t).ok).toBe(false);
  });

  it("exact stage flags never default to all-on", () => {
    const b = exactStageFlags("B");
    expect(b.contract_conformance).toBe(true);
    expect(b.capability_freshness).toBe(true);
    expect(b.structured_semantics).toBe(false);
    expect(b.diagnosis_policy).toBe(false);
    expect(b.effect_safety).toBe(false);
    expect(b.state_recovery).toBe(false);
    expect(assertExactFlags(b, b).ok).toBe(true);
  });
});

describe("P0 registered WebMCP substrate", () => {
  it("defines concrete schemas for purchase and get_order", () => {
    expect(TOOL_INPUT_SCHEMAS.purchase_tickets).toMatchObject({
      type: "object",
      properties: { operation_id: { type: "string" } },
    });
    expect(TOOL_INPUT_SCHEMAS.get_order).toMatchObject({
      type: "object",
      properties: { operation_id: { type: "string" } },
    });
  });

  it("normalizes thrown handler errors", async () => {
    const r = await normalizeHandlerResult(() => {
      throw new Error("opaque_provider_failure");
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("opaque_provider_failure");
  });

  it("forwards operation_id on get_order when effect safety on", () => {
    const store = new ReliableRailStore(fixture);
    const rec = new EventRecorder();
    const registry = new Map();
    runToReviewed(store, rec);
    const purchase = invokeTool(store, rec, "purchase_tickets", { operation_id: "op_t" }, "t", {
      effectSafety: true,
      effectRegistry: registry,
      simulateClientTimeoutAfterCommit: true,
    });
    expect(purchase.ok).toBe(false);
    expect(purchase.error).toBe("purchase_timeout_unknown");
    const got = invokeTool(store, rec, "get_order", { operation_id: "op_t" }, "t", {
      effectSafety: true,
      effectRegistry: registry,
    });
    expect(got.ok).toBe(true);
    const data = got.data as { reconciliation?: { action: string } };
    expect(data.reconciliation).toBeTruthy();
  });
});

describe("P0 shared timeout adversity (fair arms)", () => {
  it("raw arm also receives commit-then-timeout", () => {
    const store = new ReliableRailStore(fixture);
    const rec = new EventRecorder();
    runToReviewed(store, rec);
    const r = invokeTool(store, rec, "purchase_tickets", {}, "raw", {
      simulateClientTimeoutAfterCommit: true,
      effectSafety: false,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("purchase_timeout_unknown");
    expect(store.getOrder().committed_purchase_count).toBe(1);
  });
});

describe("P0 C1/C2 mapping fixes", () => {
  it("timeout maps to ambiguous_commit → reconcile", () => {
    const env = envelopeFromToolError({
      tool: "purchase_tickets",
      error: "purchase_timeout_unknown",
      state: "PURCHASED",
      state_revision: 1,
    });
    expect(env.category).toBe("ambiguous_commit");
    const d = selectDiagnosisAction({ structuredFailure: env });
    expect(d.action).toBe("reconcile");
  });

  it("contract_violation recoverability is non_recoverable (aligns with stop)", () => {
    const env = envelopeFromToolError({
      tool: "purchase_tickets",
      error: "contract_violation",
      state: "EMPTY",
      state_revision: 0,
    });
    expect(env.recoverability).toBe("non_recoverable");
    expect(selectDiagnosisAction({ structuredFailure: env }).action).toBe("stop");
  });
});

describe("P0 D2 hydrate", () => {
  it("rehydrates PURCHASED ledger after simulated reload", () => {
    const store = new ReliableRailStore(fixture);
    const rec = new EventRecorder();
    runToReviewed(store, rec);
    invokeTool(store, rec, "purchase_tickets", {}, "d2");
    const snap = store.getOrder();
    expect(snap.state).toBe("PURCHASED");
    const reloaded = new ReliableRailStore(fixture);
    reloaded.hydrateOrder(snap);
    expect(reloaded.getOrder().state).toBe("PURCHASED");
    expect(reloaded.getOrder().committed_purchase_count).toBe(1);
    expect(reloaded.getOrder().receipt_id).toBeTruthy();
  });
});

function runToReviewed(store: ReliableRailStore, rec: EventRecorder) {
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
