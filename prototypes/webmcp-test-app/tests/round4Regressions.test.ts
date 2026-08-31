/**
 * Regressions for the five defects found in the round-4 independent review.
 *
 * The theme running through all of them: a response is not an observation. What
 * a consequential call returns — success, failure, or an exception — says nothing
 * on its own about whether the effect exists.
 */

import { describe, expect, it } from "vitest";
import { COMMITTED_EFFECT_STATES, USE_CASES } from "../src/lab/catalog.ts";
import { SuiteToolRuntime } from "../src/lab/runtime.ts";
import { recoverFromInterruption } from "../../reliability-boundary/recovery/checkpoint.ts";
import { decideRecovery, recoveryPolicySupports } from "../../reliability-boundary/recovery/stateRecovery.ts";
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

/** Wraps a real runtime so one tool's behaviour can be replaced. */
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

describe("round-4 review regressions", () => {
  it("S1 treats a failed consequential call as ambiguous when authority cannot answer", () => {
    const base = new SuiteToolRuntime();
    let externalEffects = 0;
    // The effect really happens; the response claims a timeout; authority is down.
    const { call, registration } = harness(
      adapter(base, ({ toolName, invokeBase }) => {
        if (toolName === "create_support_ticket") {
          invokeBase();
          externalEffects += 1;
          return { ok: false, error: "timeout" };
        }
        if (toolName === "get_support_ticket") {
          return { ok: true, data: { authority: "unavailable", effect: null, record: null } };
        }
        return invokeBase();
      }),
    );

    observeSupport(call);
    const first = call("support.create_support_ticket", { operation_id: "s1-hidden-one", expected_revision: 1 });
    expect(first.ok).toBe(false);
    expect(first.error).toBe("ambiguous_effect");
    expect(first.commit_status).toBe("possible");
    expect(first.allowed_next_action).toBe("reconcile");
    expect(first.next_tool).toBe("support.get_support_ticket");
    expect(externalEffects).toBe(1);

    // Following the boundary's own direction must not produce a second effect.
    observeSupport(call);
    const second = call("support.create_support_ticket", { operation_id: "s1-hidden-two", expected_revision: 2 });
    expect(second.ok).toBe(false);
    expect(externalEffects).toBe(1);
    expect(registration.session.effectCount()).toBe(0);
  });

  it("S1b adopts an effect that committed even though the call reported an error", () => {
    const base = new SuiteToolRuntime();
    const { call, registration } = harness(
      adapter(base, ({ toolName, invokeBase }) => {
        const raw = invokeBase();
        return toolName === "create_support_ticket" ? { ok: false, error: "timeout" } : raw;
      }),
    );

    observeSupport(call);
    const result = call("support.create_support_ticket", { operation_id: "s1b-committed", expected_revision: 1 });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("effect_committed_despite_error");
    expect(result.commit_status).toBe("committed");
    expect(result.allowed_next_action).toBe("stop");
    // The mirror agrees with the store instead of believing the error message.
    expect(base.effectCount()).toBe(1);
    expect(registration.session.effectCount()).toBe(1);
  });

  it("S1c allows recovery when authority proves the effect never happened", () => {
    const { call, registration } = harness(new SuiteToolRuntime() as unknown as Runtime);

    observeSupport(call);
    // Stale expected_revision is rejected before anything is stored.
    const stale = call("support.create_support_ticket", { operation_id: "s1c-stale", expected_revision: 99 });
    expect(stale.ok).toBe(false);
    expect(stale.commit_status).toBe("rejected");
    expect(stale.allowed_next_action).toBe("reobserve");
    expect(registration.session.effectCount()).toBe(0);
  });

  it("S2 turns a throwing reconcile into an ambiguous effect, not an exception", () => {
    const base = new SuiteToolRuntime();
    const { call, registration } = harness(
      adapter(base, ({ toolName, invokeBase }) => {
        if (toolName === "get_support_ticket") throw new Error("reconcile transport failed");
        return invokeBase();
      }),
    );

    observeSupport(call);
    const result = call("support.create_support_ticket", { operation_id: "s2-verify-throws", expected_revision: 1 });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("unverified_effect");
    expect(result.commit_status).toBe("possible");
    expect(registration.protocol.snapshot().decision).not.toBeNull();
    expect(base.effectCount()).toBe(1);
    expect(registration.session.effectCount()).toBe(0);
  });

  it("S3 counts characters, not code units, when checking minLength", () => {
    const { call, registration } = harness(new SuiteToolRuntime() as unknown as Runtime);
    observeSupport(call);

    // Three emoji are six UTF-16 code units but only three JSON Schema characters.
    const short = call("support.create_support_ticket", { operation_id: "😀😀😀", expected_revision: 1 });
    expect(short.ok).toBe(false);
    expect(short.error).toBe("contract_violation");
    expect(registration.session.effectCount()).toBe(0);

    // Same characters, enough of them: a fresh run commits, so the rejection above
    // is caused by the length and not by the alphabet.
    const fresh = harness(new SuiteToolRuntime() as unknown as Runtime);
    observeSupport(fresh.call);
    const longEnough = fresh.call("support.create_support_ticket", {
      operation_id: "😀😀😀😀😀😀",
      expected_revision: 1,
    });
    expect(longEnough.ok).toBe(true);
  });

  it("S4 rejects properties the registered schema forbids, including on reads", () => {
    const base = new SuiteToolRuntime();
    let dispatched = 0;
    const { call } = harness(
      adapter(base, ({ toolName, invokeBase }) => {
        if (toolName === "search_help") dispatched += 1;
        return invokeBase();
      }),
    );

    const result = call("support.search_help", { forbidden_by_schema: true });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("contract_violation");
    expect(dispatched).toBe(0);

    expect(call("support.search_help", {}).ok).toBe(true);
    expect(dispatched).toBe(1);
  });

  it("S5 recovers from every committed state the suite can reach", () => {
    for (const useCase of USE_CASES) {
      expect(recoveryPolicySupports(useCase.committedState, COMMITTED_EFFECT_STATES)).toBe(true);

      const decision = decideRecovery({
        tools_include_purchase: true,
        order_state: useCase.committedState,
        order_id: `${useCase.id}_1`,
        receipt_id: `op-${useCase.id}`,
        total_aud: null,
        budget_aud: 1_000,
        seat_ids: [],
        price_drift: false,
        seat_drift: false,
        committed_effect_states: COMMITTED_EFFECT_STATES,
      });

      // An effect that already exists must never be repeated after a reload.
      expect(decision.action).toBe("stop");
    }
  });

  it("S5b honours a registered checkpoint's own account of a committed effect", () => {
    const { call, registration } = harness(new SuiteToolRuntime() as unknown as Runtime);
    observeSupport(call);
    expect(call("support.create_support_ticket", { operation_id: "s5b-checkpoint", expected_revision: 1 }).ok).toBe(true);

    const checkpoint = registration.session.latestCheckpoint()!;
    expect(checkpoint.order_state).toBe("TICKET_OPEN");
    expect(checkpoint.postconditions_met).toBe(true);

    // Recovery is given no catalog knowledge; the checkpoint alone must be enough.
    const recovery = recoverFromInterruption({
      protocol: registration.protocol,
      checkpoint,
      current_document_epoch: null,
      current_session_epoch: null,
      ambiguous_effect_pending: false,
      observed: {
        tools_include_purchase: true,
        order_state: checkpoint.order_state,
        order_id: checkpoint.order_id,
        receipt_id: checkpoint.receipt_id,
        total_aud: null,
        budget_aud: 1_000,
        seat_ids: [],
        price_drift: false,
        seat_drift: false,
      },
    });

    expect(recovery.integrity.ok).toBe(true);
    expect(recovery.decision.action).toBe("stop");
  });

  it("S6 reports authority's effect count on a commit, not just the mirror's", () => {
    const store = new SuiteToolRuntime();
    const first = harness(store as unknown as Runtime);
    observeSupport(first.call);
    expect(first.call("support.create_support_ticket", { operation_id: "s6-before-reload", expected_revision: 1 }).ok).toBe(true);

    // A fresh boundary over the same store models a page reload.
    const cold = harness(store as unknown as Runtime);
    observeSupport(cold.call);
    const second = cold.call("support.create_support_ticket", { operation_id: "s6-after-reload", expected_revision: 2 });

    expect(second.ok).toBe(true);
    expect(store.effectCount()).toBe(2);
    expect(second.effect_count).toBe(2);
    expect(second.authoritative_effect_count).toBe(2);
    // The mirror's lower number is still reported, but labelled as the mirror's.
    expect(second.boundary_claimed_effect_count).toBe(1);
  });
});
