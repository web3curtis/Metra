import { describe, expect, it } from "vitest";
import { envelopeFromToolError } from "../../reliability-boundary/semantics/structuredFailure.ts";
import { EventRecorder, invokeTool } from "../src/domain/harness.ts";
import { ReliableRailStore } from "../src/domain/store.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Fixture } from "../src/domain/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "../../../configurations/fixtures/fixture-v0.json"), "utf8"),
) as Fixture;

describe("structured failure semantics", () => {
  it("maps contract and freshness errors to envelopes", () => {
    const c = envelopeFromToolError({
      tool: "purchase_tickets",
      error: "contract_violation",
      state: "EMPTY",
      state_revision: 0,
    });
    expect(c.category).toBe("invalid_input_or_precondition");
    const s = envelopeFromToolError({
      tool: "purchase_tickets",
      error: "stale_capability_epoch",
      state: "ORDER_REVIEWED",
      state_revision: 3,
    });
    expect(s.category).toBe("stale_observation_or_capability");
  });

  it("attaches structured_failure when flag on", () => {
    const store = new ReliableRailStore(fixture);
    const recorder = new EventRecorder();
    const result = invokeTool(store, recorder, "purchase_tickets", {}, "c1", {
      contractConformance: true,
      structuredSemantics: true,
    });
    expect(result.ok).toBe(false);
    const data = result.data as { structured_failure?: { category: string } };
    expect(data.structured_failure?.category).toBe("invalid_input_or_precondition");
  });

  it("omits structured_failure when flag off (same contract failure)", () => {
    const store = new ReliableRailStore(fixture);
    const recorder = new EventRecorder();
    const result = invokeTool(store, recorder, "purchase_tickets", {}, "c1-off", {
      contractConformance: true,
      structuredSemantics: false,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("contract_violation");
    const data = result.data as { structured_failure?: unknown } | undefined;
    expect(data?.structured_failure).toBeUndefined();
    const last = recorder.all().at(-1);
    expect(last?.payload.structured_failure).toBeNull();
  });

  it("attaches envelope on stale epoch when semantics on", () => {
    const store = new ReliableRailStore(fixture);
    const recorder = new EventRecorder();
    const result = invokeTool(store, recorder, "purchase_tickets", {}, "c1-stale", {
      capabilityFreshness: true,
      structuredSemantics: true,
      expectedCapabilityEpoch: "epoch:old",
      actualCapabilityEpoch: "epoch:new",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("stale_capability_epoch");
    const data = result.data as {
      structured_failure?: { category: string; evidence: string[] };
    };
    expect(data.structured_failure?.category).toBe("stale_observation_or_capability");
    expect(data.structured_failure?.evidence).toContain(
      "capability_freshness_rejectStaleConsequential",
    );
  });

  it("attaches diagnosis_action when C2 policy on", () => {
    const store = new ReliableRailStore(fixture);
    const recorder = new EventRecorder();
    const result = invokeTool(store, recorder, "purchase_tickets", {}, "c2", {
      capabilityFreshness: true,
      structuredSemantics: true,
      diagnosisPolicy: true,
      expectedCapabilityEpoch: "epoch:old",
      actualCapabilityEpoch: "epoch:new",
    });
    const data = result.data as {
      diagnosis_action?: { action: string };
    };
    expect(data.diagnosis_action?.action).toBe("reobserve");
  });
});
