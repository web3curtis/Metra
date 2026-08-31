/**
 * The boundary owns the verdict, so it must not accept a handler's word about
 * effects the boundary never observed, and it must enforce every constraint the
 * registered input schema declares.
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
  allowed_next_action?: string;
  next_tool?: string | null;
};

function harness(handlerOverride?: (toolName: string, args: Record<string, unknown>) => unknown) {
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
      if (handlerOverride) {
        const forced = handlerOverride(toolName, args);
        if (forced !== undefined) return forced;
      }
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
  return { call, dispatched, effects: () => real.effectCount() };
}

const SUPPORT_ACT = "support.create_support_ticket";

describe("the boundary does not take the handler's word for an effect", () => {
  it("refuses a duplicate_prevented claim with no commit in the boundary ledger", () => {
    const h = harness((toolName, args) =>
      toolName === "create_support_ticket"
        ? {
            ok: true,
            data: {
              operation_id: args.operation_id,
              effect_id: "ghost-effect",
              revision: 1,
              priority: "P2",
              duplicate_prevented: true,
              effect_count: 0,
            },
          }
        : undefined,
    );

    h.call("support.search_help", {});
    h.call("support.get_customer_context", {});
    const env = h.call(SUPPORT_ACT, {
      operation_id: "ghost-duplicate",
      expected_revision: 1,
    });

    // Reporting ok here would tell the agent a ticket exists when none does.
    expect(env.ok).toBe(false);
    expect(env.error).toBe("unverified_effect");
    // Authority was readable and said no such record exists, which is why the
    // handler's duplicate claim is refused rather than merely left unconfirmed.
    const failure = env.structured_failure as Record<string, unknown>;
    expect(failure.category).toBe("ambiguous_effect");
    expect(failure.actual).toBe("authority_says_absent");
    expect(env.allowed_next_action).toBe("reconcile");
    expect(env.next_tool).toBe("support.get_support_ticket");
    expect(env.effect_count).toBe(0);
    expect(h.effects()).toBe(0);
  });

  it("still honours a duplicate the boundary itself recorded", () => {
    const h = harness();
    h.call("support.search_help", {});
    h.call("support.get_customer_context", {});
    const first = h.call(SUPPORT_ACT, {
      operation_id: "honest-duplicate",
      expected_revision: 1,
    });
    expect(first.ok).toBe(true);
    h.call("support.get_support_ticket", { operation_id: "honest-duplicate" });

    const replay = h.call(SUPPORT_ACT, {
      operation_id: "honest-duplicate",
      expected_revision: 1,
    });
    expect(replay.ok).toBe(true);
    expect(h.effects()).toBe(1);
  });
});

describe("declared schema constraints fail closed", () => {
  it("rejects an operation_id shorter than the declared minLength", () => {
    const h = harness();
    h.call("support.search_help", {});
    h.call("support.get_customer_context", {});
    const env = h.call(SUPPORT_ACT, { operation_id: "x", expected_revision: 1 });

    expect(env.ok).toBe(false);
    expect(env.error).toBe("contract_violation");
    expect(h.dispatched).not.toContain(SUPPORT_ACT);
    expect(h.effects()).toBe(0);
  });

  it("rejects a reconcile operation_id shorter than the declared minLength", () => {
    const h = harness();
    const env = h.call("support.get_support_ticket", { operation_id: "x" });
    expect(env.ok).toBe(false);
    expect(env.error).toBe("contract_violation");
  });
});
