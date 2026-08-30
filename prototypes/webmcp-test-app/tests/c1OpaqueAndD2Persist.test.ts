import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { EventRecorder, invokeTool } from "../src/domain/harness.ts";
import { ReliableRailStore } from "../src/domain/store.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Fixture } from "../src/domain/types.ts";
import { exactStageFlags } from "../src/adversity/adversityEngine.ts";
import {
  clearAllSessionPersist,
  loadLedger,
  saveLedger,
} from "../src/persist/sessionPersist.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "../../../configurations/fixtures/fixture-v0.json"), "utf8"),
) as Fixture;

describe("C1 exact-stage opaque off vs on (identical error)", () => {
  it("same opaque error: off lacks envelope, on has complete fields", () => {
    const opaque = "opaque_provider_failure";
    const flagsOn = exactStageFlags("C1");

    const offStore = new ReliableRailStore(fixture);
    const offRec = new EventRecorder();
    prep(offStore, offRec);
    const off = invokeTool(offStore, offRec, "purchase_tickets", {}, "c1-off", {
      injectOpaqueError: opaque,
      structuredSemantics: false,
    });
    expect(off.ok).toBe(false);
    expect(off.error).toBe(opaque);
    expect(
      (off.data as { structured_failure?: unknown } | undefined)?.structured_failure,
    ).toBeFalsy();

    const onStore = new ReliableRailStore(fixture);
    const onRec = new EventRecorder();
    prep(onStore, onRec);
    const on = invokeTool(onStore, onRec, "purchase_tickets", {}, "c1-on", {
      injectOpaqueError: opaque,
      contractConformance: flagsOn.contract_conformance,
      capabilityFreshness: flagsOn.capability_freshness,
      structuredSemantics: true,
      diagnosisPolicy: false,
      expectedCapabilityEpoch: "epoch:stable",
      actualCapabilityEpoch: "epoch:stable",
    });
    expect(on.ok).toBe(false);
    expect(on.error).toBe(opaque);
    const sf = (on.data as { structured_failure: {
      category: string;
      owner: string;
      recoverability: string;
      evidence: string[];
      tool: string;
      state_revision: number;
    } }).structured_failure;
    expect(sf.category).toBe("execution_error");
    expect(sf.owner).toBeTruthy();
    expect(sf.recoverability).toBeTruthy();
    expect(sf.evidence.length).toBeGreaterThan(0);
    expect(sf.tool).toBe("purchase_tickets");
    expect(typeof sf.state_revision).toBe("number");
  });
});

describe("D2 localStorage ledger survival", () => {
  const mem = new Map<string, string>();
  beforeEach(() => {
    mem.clear();
    // @ts-expect-error test stub
    globalThis.localStorage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => {
        mem.set(k, v);
      },
      removeItem: (k: string) => {
        mem.delete(k);
      },
    };
  });
  afterEach(() => {
    clearAllSessionPersist();
    // @ts-expect-error cleanup
    delete globalThis.localStorage;
  });

  it("save/load retains PURCHASED receipt across new store", () => {
    const store = new ReliableRailStore(fixture);
    const rec = new EventRecorder();
    prep(store, rec);
    invokeTool(store, rec, "purchase_tickets", {}, "d2");
    saveLedger(store.getOrder());
    const loaded = loadLedger();
    expect(loaded?.order.state).toBe("PURCHASED");
    const next = new ReliableRailStore(fixture);
    next.hydrateOrder(loaded!.order);
    expect(next.getOrder().receipt_id).toBeTruthy();
    expect(next.getOrder().committed_purchase_count).toBe(1);
  });
});

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
