/**
 * Adversarial assessment of the registered-path boundary.
 *
 * Every attack below drives only registered tools, exactly as an agent would.
 * The goal is to produce a committed effect without both required observations
 * being current, or to make a failure look like a success.
 */

import { describe, expect, it } from "vitest";
import { USE_CASES } from "../src/lab/catalog.ts";
import { SuiteToolRuntime } from "../src/lab/runtime.ts";
import { registerUseCaseSuite } from "../src/webmcp/registerSuite.ts";

type RegisteredTool = {
  name: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
  execute: (args: Record<string, unknown>) => unknown;
};

type Envelope = Record<string, unknown> & {
  ok?: boolean;
  error?: string;
  effect_count?: number;
  data?: Record<string, unknown>;
};

/** Registers the suite and returns a caller plus the live runtime. */
function harness(handlerOverride?: (toolName: string) => unknown) {
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
        const forced = handlerOverride(toolName);
        if (forced !== undefined) return forced;
      }
      return (
        real as unknown as {
          execute: (u: unknown, t: string, a: unknown) => unknown;
        }
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
  return { call, registered, dispatched, registration, effects: () => real.effectCount() };
}

const SUPPORT_ACT = "support.create_support_ticket";

describe("adversarial: no effect without current required evidence", () => {
  it("A1 rejects a premature act carrying an unknown extra argument", () => {
    const h = harness();
    const env = h.call(SUPPORT_ACT, {
      operation_id: "adv-a1",
      expected_revision: 1,
      force: true,
      skip_preconditions: true,
    });
    expect(env.ok).toBe(false);
    expect(h.effects()).toBe(0);
    expect(env.effect_count).toBe(0);
    // Unknown fields on a consequential tool are a contract violation, not a
    // silently ignored extra.
    expect(env.error).toBe("contract_violation");
    expect(h.dispatched).toEqual([]);
  });

  it("A2 never commits when expected_revision arrives as a numeric string", () => {
    const h = harness();
    const env = h.call(SUPPORT_ACT, { operation_id: "adv-a2", expected_revision: "1" });
    expect(env.ok).toBe(false);
    expect(h.effects()).toBe(0);
    expect(h.dispatched).toEqual([]);
  });

  it("A3 rejects a non-string operation_id", () => {
    const h = harness();
    const env = h.call(SUPPORT_ACT, { operation_id: 12345, expected_revision: 1 });
    expect(env.ok).toBe(false);
    expect(env.error).toBe("contract_violation");
    expect(h.effects()).toBe(0);
    expect(h.dispatched).toEqual([]);
  });

  it("A4 does not accept another use case's evidence", () => {
    const h = harness();
    h.call("travel.search_trips", {});
    h.call("travel.get_trip", {});
    const env = h.call(SUPPORT_ACT, { operation_id: "adv-a4", expected_revision: 1 });
    expect(env.ok).toBe(false);
    expect(env.missing_evidence).toEqual([
      "support.verified_help",
      "support.customer_context",
    ]);
    expect(h.effects()).toBe(0);
  });

  it("A5 blocks when only one of two required observations is present", () => {
    const h = harness();
    h.call("support.search_help", {});
    const env = h.call(SUPPORT_ACT, { operation_id: "adv-a5", expected_revision: 1 });
    expect(env.ok).toBe(false);
    expect(env.missing_evidence).toEqual(["support.customer_context"]);
    expect(env.next_tool).toBe("support.get_customer_context");
    expect(h.effects()).toBe(0);
  });

  it("A6 forces reconciliation before any further consequential call", () => {
    const h = harness();
    h.call("support.search_help", {});
    h.call("support.get_customer_context", {});
    const first = h.call(SUPPORT_ACT, { operation_id: "adv-a6-one", expected_revision: 1 });
    expect(first.ok).toBe(true);
    expect(h.effects()).toBe(1);

    // A committed effect is unverified, so a second act is refused outright.
    const second = h.call(SUPPORT_ACT, { operation_id: "adv-a6-two", expected_revision: 2 });
    expect(second.ok).toBe(false);
    expect(second.error).toBe("decision_requires_reconcile");
    expect(h.effects()).toBe(1);
  });

  it("A6b still blocks stale evidence after reconciliation clears the gate", () => {
    const h = harness();
    h.call("support.search_help", {});
    h.call("support.get_customer_context", {});
    h.call(SUPPORT_ACT, { operation_id: "adv-a6b-one", expected_revision: 1 });
    const reconciled = h.call("support.get_support_ticket", { operation_id: "adv-a6b-one" });
    expect(reconciled.ok).toBe(true);

    // Reconciliation satisfies the verify gate. The observations are still from
    // revision 1, so a brand new effect must remain blocked on freshness.
    const second = h.call(SUPPORT_ACT, { operation_id: "adv-a6b-two", expected_revision: 2 });
    expect(second.ok).toBe(false);
    expect(second.error).toBe("stale_precondition");
    expect(second.stale_evidence).toEqual([
      "support.verified_help",
      "support.customer_context",
    ]);
    expect(h.effects()).toBe(1);
  });

  it("A6c holds a spent effect budget closed even after fresh re-observation", () => {
    const h = harness();
    h.call("support.search_help", {});
    h.call("support.get_customer_context", {});
    h.call(SUPPORT_ACT, { operation_id: "adv-a6c-one", expected_revision: 1 });
    h.call("support.get_support_ticket", { operation_id: "adv-a6c-one" });
    h.call("support.search_help", {});
    h.call("support.get_customer_context", {});
    const second = h.call(SUPPORT_ACT, { operation_id: "adv-a6c-two", expected_revision: 2 });
    // Exactly-once is declared per consequential tool rather than inferred from
    // whether the freshness gate happens to be open, so re-observing does not
    // buy a second effect. Fresh evidence used to reopen dispatch here.
    expect(second.ok).toBe(false);
    expect(second.error).toBe("effect_budget_exhausted");
    const failure = second.structured_failure as Record<string, unknown>;
    expect(failure.expected).toBe("at_most_1_effects");
    expect(h.effects()).toBe(1);
  });

  it("A7 commits exactly once when the same operation_id is replayed", () => {
    const h = harness();
    h.call("support.search_help", {});
    h.call("support.get_customer_context", {});
    h.call(SUPPORT_ACT, { operation_id: "adv-a7", expected_revision: 1 });
    h.call(SUPPORT_ACT, { operation_id: "adv-a7", expected_revision: 1 });
    h.call(SUPPORT_ACT, { operation_id: "adv-a7", expected_revision: 1 });
    expect(h.effects()).toBe(1);
  });

  it("A8 sweeps every use case: a premature act never commits", () => {
    for (const useCase of USE_CASES) {
      const h = harness();
      const act = useCase.tools.find((t) => t.role === "act")!;
      const env = h.call(`${useCase.id}.${act.name}`, {
        operation_id: `adv-a8-${useCase.id}`,
        expected_revision: 1,
      });
      expect(env.ok, `${useCase.id} must refuse`).toBe(false);
      expect(h.effects(), `${useCase.id} must have zero effects`).toBe(0);
      expect(h.dispatched, `${useCase.id} must not dispatch`).toEqual([]);
    }
  });

  it("A9 sweeps every use case: the ordered path commits exactly once", () => {
    for (const useCase of USE_CASES) {
      const h = harness();
      const [discover, inspect, act] = [
        useCase.tools.find((t) => t.role === "discover")!,
        useCase.tools.find((t) => t.role === "inspect")!,
        useCase.tools.find((t) => t.role === "act")!,
      ];
      h.call(`${useCase.id}.${discover.name}`, {});
      h.call(`${useCase.id}.${inspect.name}`, {});
      const env = h.call(`${useCase.id}.${act.name}`, {
        operation_id: `adv-a9-${useCase.id}`,
        expected_revision: 1,
      });
      expect(env.ok, `${useCase.id} ordered path must succeed`).toBe(true);
      expect(h.effects(), `${useCase.id} must commit once`).toBe(1);
    }
  });
});

describe("adversarial: a lying handler cannot fake a success", () => {
  it("A10 still refuses a premature call when the handler always returns ok", () => {
    const h = harness(() => ({ ok: true }));
    const env = h.call(SUPPORT_ACT, { operation_id: "adv-a10", expected_revision: 1 });
    expect(env.ok).toBe(false);
    expect(h.dispatched).toEqual([]);
    expect(env.effect_count).toBe(0);
  });

  it("A11 reports malformed_success rather than ok when postconditions are absent", () => {
    const h = harness((toolName) =>
      toolName === "create_support_ticket" ? { ok: true } : undefined,
    );
    h.call("support.search_help", {});
    h.call("support.get_customer_context", {});
    const env = h.call(SUPPORT_ACT, { operation_id: "adv-a11", expected_revision: 1 });
    expect(env.ok).toBe(false);
    expect(env.error).toBe("malformed_success");
    // The agent must be told to reconcile, because the effect may have landed.
    expect(env.allowed_next_action).toBe("reconcile");
    expect(env.next_tool).toBe("support.get_support_ticket");
  });

  it("A12 rejects a partial success that omits effect_id", () => {
    const h = harness((toolName) =>
      toolName === "create_support_ticket"
        ? { ok: true, data: { operation_id: "adv-a12", revision: 2 } }
        : undefined,
    );
    h.call("support.search_help", {});
    h.call("support.get_customer_context", {});
    const env = h.call(SUPPORT_ACT, { operation_id: "adv-a12", expected_revision: 1 });
    expect(env.ok).toBe(false);
    expect(env.error).toBe("malformed_success");
  });

  it("A13 never surfaces a thrown handler as ok", () => {
    const h = harness((toolName) => {
      if (toolName === "create_support_ticket") throw new Error("boom");
      return undefined;
    });
    h.call("support.search_help", {});
    h.call("support.get_customer_context", {});
    const env = h.call(SUPPORT_ACT, { operation_id: "adv-a13", expected_revision: 1 });
    expect(env.ok).toBe(false);
    expect(env.error).toBe("execution_failure");
    expect(env.allowed_next_action).toBe("reconcile");
  });
});

describe("adversarial: reconciliation cannot be spoofed", () => {
  it("A14 refuses a reconcile call with no operation_id", () => {
    const h = harness();
    const env = h.call("support.get_support_ticket", {});
    expect(env.ok).toBe(false);
    expect(env.allowed_next_action).toBe("reconcile");
  });

  it("A15 resolves an unknown id as absent rather than inventing a record", () => {
    const h = harness();
    const env = h.call("support.get_support_ticket", { operation_id: "never-existed" });
    expect(env.ok).toBe(true);
    const data = env.data as Record<string, unknown>;
    // Authority answered, and its answer was "no such effect". That is a
    // resolution, not a failure to read, so it is reported as authoritative
    // with an explicit absent resolution instead of as unavailable.
    expect(data.authority).toBe("authoritative");
    expect(data.resolution).toBe("absent");
    expect(data.record).toBeNull();
    expect(data.effect_count).toBe(0);
  });
});
