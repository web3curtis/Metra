/**
 * Simulated registered WebMCP path — proves schemas, arg forward, normalize.
 */
import { describe, expect, it } from "vitest";
import { TOOL_INPUT_SCHEMAS } from "../src/webmcp/toolSchemas.ts";
import { normalizeHandlerResult } from "../src/webmcp/register.ts";
import { EventRecorder, invokeTool } from "../src/domain/harness.ts";
import { ReliableRailStore } from "../src/domain/store.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Fixture, ToolResult } from "../src/domain/types.ts";
import type { EffectRecord } from "../../reliability-boundary/effect/effectSafety.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "../../../configurations/fixtures/fixture-v0.json"), "utf8"),
) as Fixture;

describe("registered WebMCP handler simulation", () => {
  it("forwards purchase/get_order args through a registerTool-shaped execute", async () => {
    const store = new ReliableRailStore(fixture);
    const recorder = new EventRecorder();
    const registry = new Map<string, EffectRecord>();

    const invoke = (name: string, args: Record<string, unknown>): ToolResult =>
      invokeTool(store, recorder, name as "purchase_tickets" | "get_order", args, "reg", {
        effectSafety: true,
        effectRegistry: registry,
        simulateClientTimeoutAfterCommit: name === "purchase_tickets",
        contractConformance: true,
        structuredSemantics: true,
        diagnosisPolicy: true,
      });

    const tools: Record<string, (args: Record<string, unknown>) => Promise<ToolResult>> = {
      purchase_tickets: (args) =>
        normalizeHandlerResult(() => invoke("purchase_tickets", args ?? {})),
      get_order: (args) => normalizeHandlerResult(() => invoke("get_order", args ?? {})),
    };

    // Concrete schemas present (not bare object)
    expect(TOOL_INPUT_SCHEMAS.purchase_tickets).not.toEqual({ type: "object" });
    expect(JSON.stringify(TOOL_INPUT_SCHEMAS.purchase_tickets)).toContain("operation_id");

    prep(store, recorder);
    const purchase = await tools.purchase_tickets!({ operation_id: "op_reg_1" });
    expect(purchase.ok).toBe(false);
    expect(purchase.error).toBe("purchase_timeout_unknown");
    const data = purchase.data as { operation_id?: string; structured_failure?: { category: string } };
    expect(data.operation_id).toBe("op_reg_1");
    expect(data.structured_failure?.category).toBe("ambiguous_commit");

    const got = await tools.get_order!({ operation_id: "op_reg_1" });
    expect(got.ok).toBe(true);
    const recon = (got.data as { reconciliation?: { action: string } }).reconciliation;
    expect(recon).toBeTruthy();
    expect(store.getOrder().committed_purchase_count).toBe(1);
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
