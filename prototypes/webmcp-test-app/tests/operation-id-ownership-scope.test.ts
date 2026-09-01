/**
 * Regression: operation_id ownership is enforced for every role, not only for
 * consequential tools.
 *
 * The boundary already computed `operation_id_bound_to_other_tool` for any
 * caller, but only refused on it when the contract role was "act". A reconcile
 * tool in a second web application could therefore reuse an operation_id owned
 * by a first application, reach its domain handler, and return that
 * application's absence as an authoritative answer about the original
 * operation. A verification that answers for an effect it does not own is worse
 * than no verification, so the refusal has to cover reconcile too.
 */

import { describe, expect, it } from "vitest";
import { SuiteToolRuntime } from "../src/lab/runtime.ts";
import { registerUseCaseSuite } from "../src/webmcp/registerSuite.ts";

type RegisteredTool = {
  name: string;
  execute: (args: Record<string, unknown>) => unknown;
};

type Envelope = Record<string, unknown> & {
  ok?: boolean;
  error?: string;
  effect_count?: number;
  data?: Record<string, unknown>;
};

function harness() {
  const registered: RegisteredTool[] = [];
  const dispatched: string[] = [];
  const doc = {
    modelContext: {
      registerTool(tool: RegisteredTool) {
        registered.push(tool);
      },
    },
  } as unknown as Document;

  const real = new SuiteToolRuntime();
  const runtime = {
    execute(useCase: { id: string }, toolName: string, args: Record<string, unknown>) {
      dispatched.push(`${useCase.id}.${toolName}`);
      return (
        real as unknown as { execute: (u: unknown, t: string, a: unknown) => unknown }
      ).execute(useCase, toolName, args);
    },
    effectCount: () => real.effectCount(),
  } as unknown as SuiteToolRuntime;

  registerUseCaseSuite(runtime, doc);
  const call = (name: string, args: Record<string, unknown> = {}): Envelope => {
    const tool = registered.find((item) => item.name === name);
    if (!tool) throw new Error(`not_registered:${name}`);
    return tool.execute(args) as Envelope;
  };
  const dispatchedCount = (name: string) =>
    dispatched.filter((entry) => entry === name).length;
  return { call, dispatched, dispatchedCount, effects: () => real.effectCount() };
}

describe("operation_id ownership scope", () => {
  it("refuses a cross-application reconcile that reuses another application's operation_id", () => {
    const h = harness();
    const operationId = "op-owned-by-commerce";

    const owner = h.call("commerce.get_order", { operation_id: operationId });
    expect(owner.ok).toBe(true);

    const before = h.dispatchedCount("travel.get_reservation");
    const attack = h.call("travel.get_reservation", { operation_id: operationId });

    expect(attack.ok).toBe(false);
    expect(attack.error).toBe("operation_id_conflict");
    const failure = attack.structured_failure as Record<string, unknown>;
    expect(failure.actual).toBe("operation_id_bound_to_other_tool");
    // The refusal names the application that owns the id, so the scope of the
    // conflict is readable from the failure itself.
    expect(failure.evidence).toContain("commerce.get_order");
    // No answer about travel is produced, authoritative or otherwise.
    expect(attack.data?.resolution).toBeUndefined();
    expect(h.dispatchedCount("travel.get_reservation")).toBe(before);
    expect(h.effects()).toBe(0);
  });

  it("refuses a cross-application reconcile after a real commit in the owning application", () => {
    const h = harness();
    const operationId = "op-commerce-commit";

    h.call("commerce.search_products", {});
    h.call("commerce.get_product", {});
    const purchase = h.call("commerce.create_order", {
      operation_id: operationId,
      expected_revision: 1,
    });
    expect(purchase.ok).toBe(true);
    expect(h.effects()).toBe(1);

    // The owning application's own reconcile is the legitimate follow-up.
    const verified = h.call("commerce.get_order", { operation_id: operationId });
    expect(verified.ok).toBe(true);

    const before = h.dispatchedCount("support.get_support_ticket");
    const attack = h.call("support.get_support_ticket", { operation_id: operationId });

    expect(attack.ok).toBe(false);
    expect(attack.error).toBe("operation_id_conflict");
    expect(h.dispatchedCount("support.get_support_ticket")).toBe(before);
    // The commerce effect is neither duplicated nor disowned.
    expect(h.effects()).toBe(1);
  });
});
