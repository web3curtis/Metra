import { describe, expect, it } from "vitest";
import {
  computeEpoch,
  rejectStaleConsequential,
} from "../../reliability-boundary/freshness/capabilityFreshness.ts";

describe("capability freshness", () => {
  it("stable tool set keeps the same epoch", () => {
    const a = computeEpoch(["purchase_tickets", "search_journeys"]);
    const b = computeEpoch(["search_journeys", "purchase_tickets"]);
    expect(a).toBe(b);
  });

  it("rejects stale purchase epoch", () => {
    const decision = rejectStaleConsequential(
      "purchase_tickets",
      "epoch:a",
      "epoch:b",
    );
    expect(decision.ok).toBe(false);
    expect(decision.code).toBe("stale_capability_epoch");
  });

  it("allows matching purchase epoch", () => {
    const epoch = computeEpoch(["purchase_tickets"]);
    expect(rejectStaleConsequential("purchase_tickets", epoch, epoch).ok).toBe(true);
  });

  it("invokeTool rejects stale purchase when freshness on", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { EventRecorder, invokeTool } = await import("../src/domain/harness.ts");
    const { ReliableRailStore } = await import("../src/domain/store.ts");
    const here = dirname(fileURLToPath(import.meta.url));
    const fixture = JSON.parse(
      readFileSync(join(here, "../../../configurations/fixtures/fixture-v0.json"), "utf8"),
    );
    const store = new ReliableRailStore(fixture);
    const recorder = new EventRecorder();
    // Move to ORDER_REVIEWED via contract-off path would be long; freshness check runs before store.
    const blocked = invokeTool(store, recorder, "purchase_tickets", {}, "exp-b", {
      capabilityFreshness: true,
      expectedCapabilityEpoch: "epoch:old",
      actualCapabilityEpoch: "epoch:new",
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toBe("stale_capability_epoch");
  });
});
