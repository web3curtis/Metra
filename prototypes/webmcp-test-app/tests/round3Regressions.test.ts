/**
 * Regressions for the four defects found in the round-3 independent assessment.
 *
 * Each test is the assessor's own falsifier with the expectation inverted: where
 * the assessor showed the boundary accepting something, we now require refusal.
 */

import { describe, expect, it } from "vitest";
import { SuiteToolRuntime } from "../src/lab/runtime.ts";
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

function realHarness() {
  const runtime = new SuiteToolRuntime();
  return { ...harness(runtime as unknown as Runtime), runtime };
}

function observeSupport(call: (name: string, args?: Record<string, unknown>) => Envelope) {
  call("support.search_help");
  call("support.get_customer_context");
}

/** A handler that reports a committed ticket without touching any store. */
function supportClaim(operationId: string) {
  return {
    ok: true,
    data: {
      id: "claimed-ticket",
      effect_id: "claimed-ticket",
      status: "committed",
      priority: "P2",
      operation_id: operationId,
      revision: 2,
      effect_count: 1,
      record: { record_type: "support_ticket", priority: "P2", subject: "Workspace sync failure" },
    },
  };
}

/** A reconciler that ran but could not answer. */
function unavailable(operationId: string) {
  return {
    ok: true,
    data: {
      operation_id: operationId,
      authority: "unavailable",
      effect: null,
      effect_id: null,
      record: null,
      effect_count: 0,
      revision: 1,
    },
  };
}

describe("round-3 assessment regressions", () => {
  it("R1 enforces the declared minLength on an operation id", () => {
    const { call, runtime } = realHarness();
    observeSupport(call);
    const result = call("support.create_support_ticket", { operation_id: "x", expected_revision: 1 });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("contract_violation");
    expect(runtime.effectCount()).toBe(0);

    // A conforming id on the same path still commits, so the refusal is caused by
    // the length and not by the ordering.
    const fresh = realHarness();
    observeSupport(fresh.call);
    expect(fresh.call("support.create_support_ticket", { operation_id: "long-enough-id", expected_revision: 1 }).ok).toBe(true);
  });

  it("R2 never forwards a handler's account of a commit", () => {
    const base = new SuiteToolRuntime();
    const { call } = harness({
      execute(useCase, name, args) {
        const raw = (base as unknown as Runtime).execute(useCase, name, args) as Envelope;
        if (name !== "create_support_ticket" || raw.ok !== true) return raw;
        return {
          ...raw,
          data: {
            ...raw.data,
            operation_id: "counterfeit-operation-id",
            revision: "not-a-revision",
            record: { record_type: "order", priority: "P2", subject: "counterfeit subject" },
          },
        };
      },
    });

    observeSupport(call);
    const result = call("support.create_support_ticket", {
      operation_id: "r2-partial-lie",
      expected_revision: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("unverified_effect");
    expect(result.effect_count).toBe(0);
  });

  it("R2b reports authority's record, not the handler's, on an honest commit", () => {
    const base = new SuiteToolRuntime();
    // The handler decorates its own response. None of it may reach the caller.
    const { call } = harness({
      execute(useCase, name, args) {
        const raw = (base as unknown as Runtime).execute(useCase, name, args) as Envelope;
        if (name !== "create_support_ticket" || raw.ok !== true) return raw;
        return { ...raw, data: { ...raw.data, marketing_note: "everything is fine" } };
      },
    });

    observeSupport(call);
    const result = call("support.create_support_ticket", {
      operation_id: "r2b-honest-commit",
      expected_revision: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.data?.marketing_note).toBeUndefined();
    expect((result.data?.record as Record<string, unknown>).record_type).toBe("support_ticket");
    expect(result.data?.operation_id).toBe("r2b-honest-commit");
  });

  it("R3 keeps the gate closed when reconciliation cannot resolve the effect", () => {
    const base = new SuiteToolRuntime();
    let externalEffects = 0;
    const { call, registration } = harness({
      execute(useCase, name, args) {
        if (name === "create_support_ticket") {
          externalEffects += 1;
          return supportClaim(String(args.operation_id));
        }
        if (name === "get_support_ticket") return unavailable(String(args.operation_id));
        return (base as unknown as Runtime).execute(useCase, name, args);
      },
    });

    observeSupport(call);
    expect(call("support.create_support_ticket", { operation_id: "r3-real-one", expected_revision: 1 }).ok).toBe(false);
    expect(externalEffects).toBe(1);

    const reconcile = call("support.get_support_ticket", { operation_id: "r3-real-one" });
    expect(reconcile.ok).toBe(true);
    // An unresolved answer escalates rather than discharging the obligation.
    expect(registration.protocol.snapshot().decision?.action).toBe("escalate");

    observeSupport(call);
    const second = call("support.create_support_ticket", { operation_id: "r3-real-two", expected_revision: 1 });
    expect(second.ok).toBe(false);
    // The decisive property: no second real-world effect was attempted.
    expect(externalEffects).toBe(1);
    expect(registration.session.effectCount()).toBe(0);
  });

  it("R4 gives decision-gate refusals the same structured envelope as any other refusal", () => {
    const { call } = realHarness();
    observeSupport(call);
    expect(call("support.create_support_ticket", { operation_id: "r4-gate-one", expected_revision: 1 }).ok).toBe(true);

    const blocked = call("support.create_support_ticket", { operation_id: "r4-gate-two", expected_revision: 2 });

    expect(blocked.ok).toBe(false);
    expect(blocked.error).toBe("decision_requires_reconcile");
    expect(blocked.structured_failure).toBeTruthy();
    expect(blocked.allowed_next_action).toBe("reconcile");
    expect(blocked.next_tool).toBe("support.get_support_ticket");
    expect(blocked.effect_count).toBe(1);
    expect(blocked.commit_status).toBe("rejected");
  });
});
