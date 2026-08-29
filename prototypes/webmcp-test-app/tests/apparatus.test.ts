import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EventRecorder, invokeTool, runScriptedHappyPath } from "../src/domain/harness.ts";
import { evaluateOrderOracle } from "../src/domain/oracle.ts";
import { ReliableRailStore } from "../src/domain/store.ts";
import type { Fixture } from "../src/domain/types.ts";
import { detectWebMcpLane } from "../src/webmcp/register.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "../../../configurations/fixtures/fixture-v0.json"), "utf8"),
) as Fixture;

describe("ReliableRail apparatus", () => {
  it("resets to EMPTY with zero purchases", () => {
    const store = new ReliableRailStore(fixture);
    const recorder = new EventRecorder();
    runScriptedHappyPath(store, recorder);
    const order = store.reset();
    expect(order.state).toBe("EMPTY");
    expect(order.committed_purchase_count).toBe(0);
    expect(order.order_id).toBeNull();
  });

  it("scripted happy path reaches oracle success and rejects duplicate", () => {
    const store = new ReliableRailStore(fixture);
    const recorder = new EventRecorder();
    const { purchase, duplicate } = runScriptedHappyPath(store, recorder);
    expect(purchase.ok).toBe(true);
    expect(duplicate.ok).toBe(false);
    expect(duplicate.error).toBe("duplicate_purchase_rejected");
    const oracle = evaluateOrderOracle(fixture, store.getOrder());
    expect(oracle.ok).toBe(true);
    expect(store.getOrder().committed_purchase_count).toBe(1);
  });

  it("rejects non-adjacent seats", () => {
    const store = new ReliableRailStore(fixture);
    const recorder = new EventRecorder();
    invokeTool(store, recorder, "select_journey", {
      outbound_journey_id: fixture.task_target.outbound_journey_id,
      return_journey_id: fixture.task_target.return_journey_id,
    });
    const result = invokeTool(store, recorder, "reserve_seats", {
      seat_ids: ["A1", "A3"],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("seats_not_adjacent");
  });

  it("is deterministic across repeats for oracle fields", () => {
    const digests = Array.from({ length: 3 }, () => {
      const store = new ReliableRailStore(fixture);
      const recorder = new EventRecorder();
      runScriptedHappyPath(store, recorder);
      const o = store.getOrder();
      return JSON.stringify({
        state: o.state,
        out: o.outbound_journey_id,
        ret: o.return_journey_id,
        seats: o.seat_ids,
        total: o.total_aud,
        committed: o.committed_purchase_count,
      });
    });
    expect(new Set(digests).size).toBe(1);
  });

  it("fail-closes when native lane requested without modelContext", () => {
    const fakeDoc = {} as Document;
    const detected = detectWebMcpLane(fakeDoc, "native");
    expect(detected.failClosed).toBe(true);
    expect(detected.lane).toBe("unavailable");
  });
});
