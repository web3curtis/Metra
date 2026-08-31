import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProtocolRunContext,
  redactPayload,
  wrapRegisteredToolExecute,
  SPINE_CONTRACT_VERSION,
} from "../../reliability-boundary/spine/protocolSpine.ts";
import { registerReliableRailTools } from "../src/webmcp/register.ts";
import { EventRecorder, invokeTool } from "../src/domain/harness.ts";
import { ReliableRailStore } from "../src/domain/store.ts";
import type { Fixture } from "../src/domain/types.ts";
import { evaluateOrderOracle } from "../src/domain/oracle.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const fixture = JSON.parse(
  readFileSync(join(repoRoot, "configurations/fixtures/fixture-v0.json"), "utf8"),
) as Fixture;

describe("Stage 2 shared protocol spine", () => {
  it("rejects illegal protocol transitions", () => {
    const ctx = new ProtocolRunContext();
    expect(() => ctx.transitionProtocol("act")).toThrow(/illegal_protocol_transition/);
  });

  it("redacts secrets in append-only telemetry", () => {
    const { payload, redacted } = redactPayload({
      tool: "purchase_tickets",
      api_key: "super-secret",
      nested: { token: "abc", ok: true },
    });
    expect(redacted).toBe(true);
    expect(payload.api_key).toBe("[REDACTED]");
    expect((payload.nested as { token: string }).token).toBe("[REDACTED]");
    expect((payload.nested as { ok: boolean }).ok).toBe(true);
  });

  it("routes registered tools through one boundary with shared identities", () => {
    const store = new ReliableRailStore(fixture);
    const recorder = new EventRecorder();
    const protocol = new ProtocolRunContext({
      document_epoch: "doc:1",
      session_epoch: "sess:1",
      capability_epoch: "epoch:stable",
      state_revision: 0,
    });
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
      const reg = registerReliableRailTools(
        (name, args) =>
          invokeTool(store, recorder, name as Parameters<typeof invokeTool>[2], args, "spine", {}),
        { protocol },
      );
      expect(reg.registered).toHaveLength(8);
      expect(reg.lane).toBe("native");
      invokeTool(store, recorder, "reset_fixture", {}, "spine", {});
      handlers.get("select_journey")!({
        outbound_journey_id: fixture.task_target.outbound_journey_id,
        return_journey_id: fixture.task_target.return_journey_id,
      });
      handlers.get("reserve_seats")!({ seat_ids: fixture.default_adjacent_pair });
      handlers.get("review_order")!({});
      const search = handlers.get("search_journeys")!({ origin: "SYD" });
      expect((search as { ok: boolean }).ok).toBe(true);
    } finally {
      if (previous === undefined) delete (globalThis as { document?: Document }).document;
      else (globalThis as { document?: Document }).document = previous;
    }

    const events = protocol.allEvents();
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.run_id === protocol.identities.run_id)).toBe(true);
    expect(events.every((e) => e.attempt_id === protocol.identities.attempt_id)).toBe(true);
    expect(protocol.identities.contract_version).toBe(SPINE_CONTRACT_VERSION);
    expect(events.some((e) => e.event_type === "boundary_enter")).toBe(true);

    const outDir = join(repoRoot, "artifacts/tonight/p2026.08.31.0/stage2-spine");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "spine-telemetry.jsonl"), protocol.toJsonl());
    writeFileSync(
      join(outDir, "spine-snapshot.json"),
      `${JSON.stringify(protocol.snapshot(), null, 2)}\n`,
    );
  });

  it("keeps the valid read-only happy observation path working", () => {
    const ctx = new ProtocolRunContext();
    let observed = false;
    const execute = wrapRegisteredToolExecute(
      "search_journeys",
      () => {
        observed = true;
        return { ok: true, data: { journeys: [] } };
      },
      ctx,
      { readOnly: true },
    );
    const result = execute({});
    expect(observed).toBe(true);
    expect(result).toMatchObject({ ok: true });
    expect(ctx.protocol_phase).toBe("classify");
    expect(ctx.operation_phase).toBe("none");
  });

  it("completes a full registered purchase with shared spine telemetry", () => {
    const store = new ReliableRailStore(fixture);
    const recorder = new EventRecorder();
    const protocol = new ProtocolRunContext();
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
          invokeTool(store, recorder, name as Parameters<typeof invokeTool>[2], args, "spine-happy", {}),
        { protocol },
      );
      invokeTool(store, recorder, "reset_fixture", {}, "spine-happy", {});
      handlers.get("select_journey")!({
        outbound_journey_id: fixture.task_target.outbound_journey_id,
        return_journey_id: fixture.task_target.return_journey_id,
      });
      handlers.get("reserve_seats")!({ seat_ids: fixture.default_adjacent_pair });
      handlers.get("review_order")!({});
      const purchased = handlers.get("purchase_tickets")!({});
      expect((purchased as { ok: boolean }).ok).toBe(true);
    } finally {
      if (previous === undefined) delete (globalThis as { document?: Document }).document;
      else (globalThis as { document?: Document }).document = previous;
    }
    expect(evaluateOrderOracle(fixture, store.getOrder()).ok).toBe(true);
    expect(protocol.allEvents().every((e) => e.run_id === protocol.identities.run_id)).toBe(true);
  });
});
