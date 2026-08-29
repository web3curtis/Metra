import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  reconcileAmbiguousCommit,
  rejectDuplicateOperation,
  type EffectRecord,
} from "../../reliability-boundary/effect/effectSafety.ts";
import { EventRecorder, invokeTool } from "../src/domain/harness.ts";
import { ReliableRailStore } from "../src/domain/store.ts";
import type { Fixture } from "../src/domain/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "../../../configurations/fixtures/fixture-v0.json"), "utf8"),
) as Fixture;

function reviewReady(store: ReliableRailStore, recorder: EventRecorder): void {
  const t = fixture.task_target;
  invokeTool(store, recorder, "select_journey", {
    outbound_journey_id: t.outbound_journey_id,
    return_journey_id: t.return_journey_id,
  });
  invokeTool(store, recorder, "reserve_seats", {
    seat_ids: fixture.default_adjacent_pair,
  });
  invokeTool(store, recorder, "review_order", {});
}

describe("effect safety D1", () => {
  it("rejects duplicate purchase by committed count", () => {
    const decision = rejectDuplicateOperation({
      incoming_operation_id: "op_2",
      committed_operation_ids: ["op_1"],
      committed_purchase_count: 1,
    });
    expect(decision.ok).toBe(false);
    expect(decision.code).toBe("duplicate_purchase_rejected");
  });

  it("reconcile reuses existing purchase after client timeout", () => {
    const prior: EffectRecord = {
      operation_id: "op_a",
      tool: "purchase_tickets",
      phase: "unknown",
      started_at_ms: 1,
      timeout_ms: 1000,
      order_id: "ORD-1",
      receipt_id: "RCP-1",
      state_revision_before: 4,
    };
    const r = reconcileAmbiguousCommit({
      operation_id: "op_a",
      observed: {
        state: "PURCHASED",
        order_id: "ORD-1",
        receipt_id: "RCP-1",
        committed_purchase_count: 1,
      },
      prior,
    });
    expect(r.action).toBe("reuse_existing");
  });

  it("harness: timeout-after-commit then reconcile prevents second purchase", () => {
    const store = new ReliableRailStore(fixture);
    const recorder = new EventRecorder();
    const registry = new Map<string, EffectRecord>();
    reviewReady(store, recorder);

    const timedOut = invokeTool(
      store,
      recorder,
      "purchase_tickets",
      { operation_id: "op_commit_timeout" },
      "d1",
      {
        effectSafety: true,
        effectRegistry: registry,
        simulateClientTimeoutAfterCommit: true,
      },
    );
    expect(timedOut.ok).toBe(false);
    expect(timedOut.error).toBe("purchase_timeout_unknown");
    expect(store.getOrder().committed_purchase_count).toBe(1);

    const reconciled = invokeTool(
      store,
      recorder,
      "get_order",
      { operation_id: "op_commit_timeout" },
      "d1",
      { effectSafety: true, effectRegistry: registry },
    );
    const data = reconciled.data as {
      reconciliation: { action: string };
    };
    expect(data.reconciliation.action).toBe("reuse_existing");

    const second = invokeTool(
      store,
      recorder,
      "purchase_tickets",
      { operation_id: "op_other" },
      "d1",
      { effectSafety: true, effectRegistry: registry },
    );
    expect(second.ok).toBe(false);
    expect(second.error).toBe("duplicate_purchase_rejected");
    expect(store.getOrder().committed_purchase_count).toBe(1);
  });
});
