/**
 * Regression: an operation_id committed in one web application must not carry
 * its committed phase into a different web application.
 *
 * One BoundarySession is shared by every registered tool, so the committed
 * phase and the recorded intent for an operation_id have to be scoped to the
 * use case that produced them. Otherwise a premature consequential call in app
 * B can reuse app A's operation_id, be treated as an already-committed replay,
 * and skip mechanism B entirely — reaching the domain handler with none of its
 * own required observations.
 */

import { describe, expect, it } from "vitest";
import { USE_CASES } from "../src/lab/catalog.ts";
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
  missing_evidence?: string[];
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

  const registration = registerUseCaseSuite(runtime, doc);
  const call = (name: string, args: Record<string, unknown> = {}): Envelope => {
    const tool = registered.find((item) => item.name === name);
    if (!tool) throw new Error(`not_registered:${name}`);
    return tool.execute(args) as Envelope;
  };
  return { call, dispatched, registration, effects: () => real.effectCount() };
}

const SHARED_OP = "op-shared-across-apps";

describe("cross-use-case operation_id reuse", () => {
  it("X1 does not let a commerce commit unlock a premature support act", () => {
    const h = harness();

    // Legitimate, fully observed commerce purchase under SHARED_OP.
    h.call("commerce.search_products", {});
    h.call("commerce.get_product", {});
    const purchase = h.call("commerce.create_order", {
      operation_id: SHARED_OP,
      expected_revision: 1,
    });
    expect(purchase.ok).toBe(true);
    expect(h.effects()).toBe(1);

    // Clear the C2 verify-before-further-action gate the honest way.
    const reconciled = h.call("commerce.get_order", { operation_id: SHARED_OP });
    expect(reconciled.ok).toBe(true);

    const dispatchedBefore = [...h.dispatched];

    // Support has never been observed. Reusing the commerce operation_id must
    // not be read as an already-committed support replay.
    const attack = h.call("support.create_support_ticket", {
      operation_id: SHARED_OP,
      expected_revision: 2,
    });

    expect(attack.ok).toBe(false);
    expect(attack.error).toBe("operation_id_conflict");
    // The refusal names the tool that already owns the id, so the scope of the
    // conflict is recoverable from the failure rather than only from its code.
    const failure = attack.structured_failure as Record<string, unknown>;
    expect(failure.actual).toBe("operation_id_bound_to_other_tool");
    expect(failure.evidence).toContain("commerce.create_order");
    expect(attack.allowed_next_action).toBe("stop");
    // The domain handler must never be reached.
    expect(h.dispatched).toEqual(dispatchedBefore);
    // Only the one legitimate commerce effect exists.
    expect(h.effects()).toBe(1);
    expect(attack.effect_count).toBe(1);
  });

  it("X2 sweeps every ordered pair of applications for the same bypass", () => {
    const apps = USE_CASES.map((useCase) => ({
      id: useCase.id,
      discover: `${useCase.id}.${useCase.tools.find((t) => t.role === "discover")!.name}`,
      inspect: `${useCase.id}.${useCase.tools.find((t) => t.role === "inspect")!.name}`,
      act: `${useCase.id}.${useCase.tools.find((t) => t.role === "act")!.name}`,
      reconcile: `${useCase.id}.${useCase.tools.find((t) => t.role === "reconcile")!.name}`,
    }));

    for (const source of apps) {
      for (const target of apps) {
        if (source.id === target.id) continue;
        const h = harness();
        const op = `op-${source.id}-to-${target.id}`;

        h.call(source.discover, {});
        h.call(source.inspect, {});
        const committed = h.call(source.act, { operation_id: op, expected_revision: 1 });
        expect(committed.ok, `${source.id} act must commit`).toBe(true);
        h.call(source.reconcile, { operation_id: op });

        const dispatchedBefore = [...h.dispatched];
        const attack = h.call(target.act, { operation_id: op, expected_revision: 2 });

        expect(attack.ok, `${source.id} -> ${target.id} must refuse`).toBe(false);
        expect(
          h.dispatched,
          `${source.id} -> ${target.id} must not dispatch`,
        ).toEqual(dispatchedBefore);
        expect(h.effects(), `${source.id} -> ${target.id} must add no effect`).toBe(1);
      }
    }
  });

  it("X3 still allows a same-use-case idempotent replay to be suppressed", () => {
    const h = harness();
    h.call("support.search_help", {});
    h.call("support.get_customer_context", {});
    const first = h.call("support.create_support_ticket", {
      operation_id: "op-idempotent",
      expected_revision: 1,
    });
    expect(first.ok).toBe(true);
    expect(h.effects()).toBe(1);

    h.call("support.get_support_ticket", { operation_id: "op-idempotent" });

    // Same use case, same operation_id, same intent: the replay is suppressed
    // rather than blocked on freshness, and commits nothing new.
    const replay = h.call("support.create_support_ticket", {
      operation_id: "op-idempotent",
      expected_revision: 1,
    });
    expect(replay.ok).toBe(true);
    expect(h.effects()).toBe(1);
  });
});
