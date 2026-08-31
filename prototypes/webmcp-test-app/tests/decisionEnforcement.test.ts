import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProtocolRunContext } from "../../reliability-boundary/spine/protocolSpine.ts";
import { EventRecorder, invokeTool } from "../src/domain/harness.ts";
import { ReliableRailStore } from "../src/domain/store.ts";
import type { Fixture } from "../src/domain/types.ts";
import { registerReliableRailTools } from "../src/webmcp/register.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "../../../configurations/fixtures/fixture-v0.json"), "utf8"),
) as Fixture;

describe("C2 decision enforcement at boundary", () => {
  it("blocks consequential dispatch after stop and allows get_order", () => {
    const protocol = new ProtocolRunContext();
    const store = new ReliableRailStore(fixture);
    const recorder = new EventRecorder();
    protocol.setDecision({
      action: "stop",
      reason_code: "invalid_input_or_precondition",
      evidence_refs: ["test"],
    });
    const blocked = invokeTool(store, recorder, "purchase_tickets", {}, "c2", {
      protocol,
      contractConformance: true,
      structuredSemantics: true,
      diagnosisPolicy: true,
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toBe("decision_blocks_dispatch");
    expect(store.getOrder().committed_purchase_count).toBe(0);

    const allowed = invokeTool(store, recorder, "get_order", {}, "c2", { protocol });
    expect(allowed.ok).toBe(true);
  });

  it("sets stop from contract failure then blocks the next purchase via spine wrap", () => {
    const protocol = new ProtocolRunContext();
    const store = new ReliableRailStore(fixture);
    const recorder = new EventRecorder();
    const handlers = new Map<string, (args: Record<string, unknown>) => unknown>();
    const fakeDocument = {
      modelContext: {
        registerTool(def: { name: string; execute: (args: Record<string, unknown>) => unknown }) {
          handlers.set(def.name, def.execute);
        },
      },
    } as unknown as Document;
    const previous = (globalThis as { document?: Document }).document;
    (globalThis as { document?: Document }).document = fakeDocument;
    try {
      registerReliableRailTools(
        (name, args) =>
          invokeTool(store, recorder, name as Parameters<typeof invokeTool>[2], args, "c2-wrap", {
            protocol,
            contractConformance: true,
            structuredSemantics: true,
            diagnosisPolicy: true,
          }),
        { protocol },
      );
      const first = handlers.get("purchase_tickets")!({});
      expect((first as { ok: boolean }).ok).toBe(false);
      expect(protocol.decision?.action).toBe("stop");
      const second = handlers.get("purchase_tickets")!({});
      expect(second).toMatchObject({ ok: false, error: "decision_blocks_dispatch" });
      expect(store.getOrder().committed_purchase_count).toBe(0);
    } finally {
      if (previous === undefined) delete (globalThis as { document?: Document }).document;
      else (globalThis as { document?: Document }).document = previous;
    }
  });

  it("clears reobserve after a successful read-only observation", () => {
    const protocol = new ProtocolRunContext();
    protocol.setDecision({
      action: "reobserve",
      reason_code: "stale_observation_or_capability",
      evidence_refs: ["test"],
    });
    const store = new ReliableRailStore(fixture);
    const recorder = new EventRecorder();
    const blocked = invokeTool(store, recorder, "purchase_tickets", {}, "c2", { protocol });
    expect(blocked.error).toBe("decision_requires_reobserve");
    const observed = invokeTool(store, recorder, "search_journeys", { origin: "SYD" }, "c2", {
      protocol,
    });
    expect(observed.ok).toBe(true);
    expect(protocol.decision).toBeNull();
  });
});
