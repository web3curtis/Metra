import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import {
  computeEpoch,
  rejectStaleConsequential,
} from "../../reliability-boundary/freshness/capabilityFreshness.ts";
import { EventRecorder, invokeTool } from "../src/domain/harness.ts";
import { ReliableRailStore } from "../src/domain/store.ts";
import type { Fixture } from "../src/domain/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const fixture = JSON.parse(
  readFileSync(join(root, "configurations/fixtures/fixture-v0.json"), "utf8"),
) as Fixture;

describe("exp-b capability disappearance adversity", () => {
  it("rejects purchase when purchase_tickets leaves the epoch", () => {
    const withPurchase = computeEpoch([
      "search_journeys",
      "select_journey",
      "list_available_seats",
      "reserve_seats",
      "review_order",
      "purchase_tickets",
      "get_order",
      "cancel_draft",
    ]);
    const withoutPurchase = computeEpoch([
      "search_journeys",
      "select_journey",
      "list_available_seats",
      "reserve_seats",
      "review_order",
      "get_order",
      "cancel_draft",
    ]);
    expect(withPurchase).not.toBe(withoutPurchase);

    const decision = rejectStaleConsequential(
      "purchase_tickets",
      withPurchase,
      withoutPurchase,
    );
    expect(decision.ok).toBe(false);
    expect(decision.code).toBe("stale_capability_epoch");

    const store = new ReliableRailStore(fixture);
    const recorder = new EventRecorder();
    // Reach ORDER_REVIEWED without freshness, then stale purchase
    invokeTool(store, recorder, "select_journey", {
      outbound_journey_id: fixture.task_target.outbound_journey_id,
      return_journey_id: fixture.task_target.return_journey_id,
    });
    invokeTool(store, recorder, "reserve_seats", {
      seat_ids: fixture.default_adjacent_pair,
    });
    invokeTool(store, recorder, "review_order");
    expect(store.getOrder().state).toBe("ORDER_REVIEWED");

    const blocked = invokeTool(store, recorder, "purchase_tickets", {}, "exp-b", {
      capabilityFreshness: true,
      contractConformance: true,
      expectedCapabilityEpoch: withPurchase,
      actualCapabilityEpoch: withoutPurchase,
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toBe("stale_capability_epoch");
    expect(store.getOrder().state).toBe("ORDER_REVIEWED");
    expect(store.getOrder().committed_purchase_count).toBe(0);

    const outDir = join(root, "artifacts/experiments/exp-b-freshness-v0");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, "ADVERSITY_DRYRUN.md"),
      [
        "# Exp B adversity dry-run — capability disappearance",
        "",
        "- expected epoch includes `purchase_tickets`",
        "- actual epoch removes it",
        "- purchase rejected: `stale_capability_epoch`",
        "- order remained `ORDER_REVIEWED`, committed_purchase_count=0",
        "",
        `expected: \`${withPurchase}\``,
        `actual: \`${withoutPurchase}\``,
        "",
      ].join("\n"),
    );
  });
});
