/**
 * Regressions for the three defects found in the round-5 independent review.
 *
 * All three come from the same mistake: treating a partial answer as an answer.
 * An authoritative reply must be complete and self-consistent to count, and a
 * task that asks for one effect must be able to say so rather than rely on
 * whichever gate happens to be closed.
 */

import { describe, expect, it } from "vitest";
import { SuiteToolRuntime } from "../src/lab/runtime.ts";
import { getSuiteToolContract } from "../src/lab/suiteContracts.ts";
import { recoveryPolicySupports } from "../../reliability-boundary/recovery/stateRecovery.ts";
import { registerUseCaseSuite } from "../src/webmcp/registerSuite.ts";

type RegisteredTool = { name: string; execute: (args: Record<string, unknown>) => unknown };
type Envelope = Record<string, unknown> & { ok?: boolean; data?: Record<string, unknown> };
type Runtime = { execute: (useCase: unknown, name: string, args: Record<string, unknown>) => unknown };

function harness(runtime: Runtime) {
  const registered: RegisteredTool[] = [];
  const fakeDocument = {
    modelContext: { registerTool: (tool: RegisteredTool) => registered.push(tool) },
  } as unknown as Document;
  const registration = registerUseCaseSuite(runtime as unknown as SuiteToolRuntime, fakeDocument);
  const call = (name: string, args: Record<string, unknown> = {}): Envelope =>
    registered.find((item) => item.name === name)!.execute(args) as Envelope;
  return { call, registration };
}

function adapter(
  base: SuiteToolRuntime,
  intercept: (input: { toolName: string; args: Record<string, unknown>; invokeBase: () => unknown }) => unknown,
): Runtime {
  return {
    execute(useCase, toolName, args) {
      return intercept({
        toolName,
        args,
        invokeBase: () => (base as unknown as Runtime).execute(useCase, toolName, args),
      });
    },
  };
}

function observeSupport(call: (name: string, args?: Record<string, unknown>) => Envelope) {
  call("support.search_help");
  call("support.get_customer_context");
}

describe("round-5 review regressions", () => {
  it("T1 refuses a 'committed' answer that carries no record", () => {
    const base = new SuiteToolRuntime();
    const { call, registration } = harness(
      adapter(base, ({ toolName, args, invokeBase }) => {
        if (toolName === "create_support_ticket") return { ok: false, error: "timeout" };
        if (toolName === "get_support_ticket") {
          return {
            ok: true,
            data: {
              operation_id: String(args.operation_id),
              authority: "authoritative",
              resolution: "committed",
              effect: null,
              record: null,
              effect_count: 1,
              revision: 2,
            },
          };
        }
        return invokeBase();
      }),
    );

    observeSupport(call);
    const result = call("support.create_support_ticket", { operation_id: "t1-empty-committed", expected_revision: 1 });

    expect(result.ok).toBe(false);
    expect(result.commit_status).toBe("possible");
    expect(result.effect_count).toBe(0);
    expect(base.effectCount()).toBe(0);
    expect(registration.session.effectCount()).toBe(0);
    expect(registration.session.latestCheckpoint()?.postconditions_met).toBe(false);
  });

  it("T2 refuses an answer that omits its resolution rather than inferring absence", () => {
    const base = new SuiteToolRuntime();
    let externalEffects = 0;
    const { call, registration } = harness(
      adapter(base, ({ toolName, args, invokeBase }) => {
        if (toolName === "create_support_ticket") {
          invokeBase();
          externalEffects += 1;
          return { ok: false, error: "timeout" };
        }
        if (toolName === "get_support_ticket") {
          return {
            ok: true,
            data: { operation_id: String(args.operation_id), authority: "authoritative", effect_count: 1, revision: 2 },
          };
        }
        return invokeBase();
      }),
    );

    observeSupport(call);
    const first = call("support.create_support_ticket", { operation_id: "t2-silent-one", expected_revision: 1 });

    // Silence is not proof that nothing happened, so this stays ambiguous.
    expect(first.ok).toBe(false);
    expect(first.error).toBe("ambiguous_effect");
    expect(first.allowed_next_action).toBe("reconcile");
    expect(externalEffects).toBe(1);

    observeSupport(call);
    call("support.create_support_ticket", { operation_id: "t2-silent-two", expected_revision: 2 });
    expect(externalEffects).toBe(1);
    expect(registration.session.effectCount()).toBe(0);
  });

  it("T3 refuses a committed answer describing another use case's record", () => {
    const base = new SuiteToolRuntime();
    const { call } = harness(
      adapter(base, ({ toolName, args, invokeBase }) => {
        if (toolName === "create_support_ticket") return { ok: false, error: "timeout" };
        if (toolName === "get_support_ticket") {
          const operationId = String(args.operation_id);
          return {
            ok: true,
            data: {
              operation_id: operationId,
              authority: "authoritative",
              resolution: "committed",
              effect: { id: "x1", status: "committed", operation_id: operationId },
              effect_id: "x1",
              record: { record_type: "order", total_aud: 169 },
              effect_count: 1,
              revision: 2,
            },
          };
        }
        return invokeBase();
      }),
    );

    observeSupport(call);
    const result = call("support.create_support_ticket", { operation_id: "t3-wrong-record", expected_revision: 1 });

    expect(result.ok).toBe(false);
    expect(result.commit_status).toBe("possible");
    expect(result.effect_count).toBe(0);
  });

  it("T4 stops at the declared effect budget even with everything else in order", () => {
    const contract = getSuiteToolContract("support.create_support_ticket")!;
    expect(contract.effect_budget).toBe(1);

    const runtime = new SuiteToolRuntime();
    const { call, registration } = harness(runtime as unknown as Runtime);

    observeSupport(call);
    expect(call("support.create_support_ticket", { operation_id: "t4-first", expected_revision: 1 }).ok).toBe(true);
    expect(call("support.get_support_ticket", { operation_id: "t4-first" }).ok).toBe(true);

    // Reconciled, then fully re-observed: every other gate is now open.
    observeSupport(call);
    const second = call("support.create_support_ticket", { operation_id: "t4-second", expected_revision: 2 });

    expect(second.ok).toBe(false);
    expect(second.error).toBe("effect_budget_exhausted");
    expect(second.allowed_next_action).toBe("stop");
    expect(second.next_tool).toBeNull();
    expect(runtime.effectCount()).toBe(1);
    expect(registration.session.effectCount()).toBe(1);
  });

  it("T4b still replays the original operation id without a second effect", () => {
    const runtime = new SuiteToolRuntime();
    const { call } = harness(runtime as unknown as Runtime);

    observeSupport(call);
    call("support.create_support_ticket", { operation_id: "t4b-only", expected_revision: 1 });
    call("support.get_support_ticket", { operation_id: "t4b-only" });
    observeSupport(call);

    // A byte-identical retry is the same intent, so the budget must not turn
    // idempotent replay into a hard failure.
    const replay = call("support.create_support_ticket", { operation_id: "t4b-only", expected_revision: 1 });
    expect(replay.ok).toBe(true);
    expect(replay.data?.duplicate_prevented).toBe(true);
    expect(runtime.effectCount()).toBe(1);
  });

  it("T5 does not call a blocked checkpoint resumable", () => {
    const { call, registration } = harness(new SuiteToolRuntime() as unknown as Runtime);

    const blocked = call("support.create_support_ticket", { operation_id: "t5-premature", expected_revision: 1 });
    expect(blocked.ok).toBe(false);

    const checkpoint = registration.session.latestCheckpoint()!;
    expect(checkpoint.postconditions_met).toBe(false);
    expect(recoveryPolicySupports(checkpoint.order_state)).toBe(false);

    const bound = registration.protocol
      .allEvents()
      .filter((event) => event.event_type === "checkpoint_bound")
      .at(-1)!;
    expect(bound.payload.resumable).toBe(false);
  });
});
