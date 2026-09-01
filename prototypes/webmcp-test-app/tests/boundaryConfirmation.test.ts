/**
 * Regression falsifiers for CURSOR_HANDOVER_RUNTIME_FAILURE_003.
 *
 * Codex found three ways a claim could still be mistaken for a fact: a
 * confirmation that only checked identity, a shared operation-id space that let
 * one use case's record certify another's action, and a reconcile that read an
 * authoritative commit without ever adopting it. Each is pinned here through the
 * registered WebMCP path.
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

type RuntimeShape = { execute: (useCase: unknown, toolName: string, args: Record<string, unknown>) => unknown };

/** Registers the suite against a runtime, real or substituted. */
function harness(runtime: SuiteToolRuntime) {
  const registered: RegisteredTool[] = [];
  const fakeDocument = {
    modelContext: {
      registerTool(tool: RegisteredTool) {
        registered.push(tool);
      },
    },
  } as unknown as Document;
  const registration = registerUseCaseSuite(runtime, fakeDocument);
  const call = (name: string, args: Record<string, unknown> = {}): Envelope => {
    const tool = registered.find((item) => item.name === name);
    if (!tool) throw new Error(`tool_not_registered:${name}`);
    return tool.execute(args) as Envelope;
  };
  return { call, registration };
}

/** Wraps a real runtime and rewrites one tool's successful response. */
function tamper(
  base: SuiteToolRuntime,
  toolName: string,
  rewrite: (data: Record<string, unknown>) => Record<string, unknown>,
): SuiteToolRuntime {
  return {
    execute(useCase: unknown, name: string, args: Record<string, unknown>) {
      const result = (base as unknown as RuntimeShape).execute(useCase, name, args) as Envelope;
      if (name !== toolName || result?.ok !== true) return result;
      return { ...result, data: rewrite((result.data ?? {}) as Record<string, unknown>) };
    },
  } as unknown as SuiteToolRuntime;
}

function observeSupport(call: (name: string, args?: Record<string, unknown>) => Envelope) {
  call("support.search_help");
  call("support.get_customer_context");
}

describe("boundary confirmation cannot be satisfied by a claim", () => {
  it("G1 refuses a commit whose claimed effect count disagrees with authority", () => {
    const base = new SuiteToolRuntime();
    const { call, registration } = harness(
      tamper(base, "create_support_ticket", (data) => ({ ...data, effect_count: 7 })),
    );

    observeSupport(call);
    const claimed = call("support.create_support_ticket", {
      operation_id: "g1-count-disagreement",
      expected_revision: 1,
    });

    expect(claimed.ok).toBe(false);
    expect(claimed.error).toBe("unverified_effect");
    // The boundary reports what it has confirmed, never the inflated claim.
    expect(claimed.effect_count).toBe(0);
    expect(claimed.commit_status).toBe("possible");
    expect(registration.session.latestCheckpoint()?.postconditions_met).toBe(false);
  });

  it("G2 refuses a commit whose claimed revision disagrees with authority", () => {
    const base = new SuiteToolRuntime();
    const { call } = harness(tamper(base, "create_support_ticket", (data) => ({ ...data, revision: 99 })));

    observeSupport(call);
    const claimed = call("support.create_support_ticket", {
      operation_id: "g2-revision-disagreement",
      expected_revision: 1,
    });

    expect(claimed.ok).toBe(false);
    expect(claimed.error).toBe("unverified_effect");
    expect(claimed.effect_count).toBe(0);
  });

  it("G3 refuses a commit whose authoritative record is not yet committed", () => {
    const base = new SuiteToolRuntime();
    const pending = tamper(base, "get_support_ticket", (data) => ({
      ...data,
      effect: { ...(data.effect as Record<string, unknown>), status: "pending" },
    }));
    const { call, registration } = harness(pending);

    observeSupport(call);
    const claimed = call("support.create_support_ticket", {
      operation_id: "g3-not-committed",
      expected_revision: 1,
    });

    expect(claimed.ok).toBe(false);
    expect(claimed.error).toBe("unverified_effect");
    expect(claimed.effect_count).toBe(0);
    expect(registration.session.effectCount()).toBe(0);
  });

  it("G4 refuses a commit whose authoritative record is the wrong kind of thing", () => {
    const base = new SuiteToolRuntime();
    const wrongKind = tamper(base, "get_support_ticket", (data) => ({
      ...data,
      record: { record_type: "order", priority: "P2" },
    }));
    const { call } = harness(wrongKind);

    observeSupport(call);
    const claimed = call("support.create_support_ticket", {
      operation_id: "g4-record-type",
      expected_revision: 1,
    });

    expect(claimed.ok).toBe(false);
    expect(claimed.error).toBe("unverified_effect");
    expect(claimed.effect_count).toBe(0);
  });

  it("G5 refuses a commit whose domain postcondition authority disagrees with", () => {
    const base = new SuiteToolRuntime();
    const downgraded = tamper(base, "get_support_ticket", (data) => ({
      ...data,
      record: { ...(data.record as Record<string, unknown>), priority: "P4" },
    }));
    const { call } = harness(downgraded);

    observeSupport(call);
    const claimed = call("support.create_support_ticket", {
      operation_id: "g5-postcondition",
      expected_revision: 1,
    });

    expect(claimed.ok).toBe(false);
    expect(claimed.error).toBe("unverified_effect");
    expect(claimed.effect_count).toBe(0);
  });

  it("G6 will not let one use case's operation id certify another's action", () => {
    const runtime = new SuiteToolRuntime();
    const { call, registration } = harness(runtime);

    call("commerce.search_products");
    call("commerce.get_product");
    const order = call("commerce.create_order", { operation_id: "shared-id-001", expected_revision: 1 });
    expect(order.ok).toBe(true);
    // Settle the committed effect so the refusal below is about identity reuse
    // rather than the outstanding verify-before-acting decision.
    expect(call("commerce.get_order", { operation_id: "shared-id-001" }).ok).toBe(true);

    call("travel.search_trips");
    call("travel.get_trip");
    const reservation = call("travel.reserve_trip", { operation_id: "shared-id-001", expected_revision: 2 });

    expect(reservation.ok).toBe(false);
    expect(reservation.error).toBe("operation_id_conflict");
    // Exactly one effect exists, and it is still the order.
    expect(registration.session.effectCount()).toBe(1);
    expect(runtime.effectCount()).toBe(1);

    // The same reuse is refused through travel's reconcile tool too. An
    // authoritative "absent" here would be a statement about travel's own
    // records dressed as an answer about the commerce order.
    const reconciled = call("travel.get_reservation", { operation_id: "shared-id-001" });
    expect(reconciled.ok).toBe(false);
    expect(reconciled.error).toBe("operation_id_conflict");
    expect(runtime.effectCount()).toBe(1);
  });

  it("G7 adopts a commit that only reconciliation reveals", () => {
    const base = new SuiteToolRuntime();
    // The commit happens, but the response is unusable, so the boundary must not
    // count it yet. Reconciliation is the only thing that can settle the question.
    const { call, registration } = harness(
      tamper(base, "create_support_ticket", (data) => ({ ...data, effect_count: 7 })),
    );

    observeSupport(call);
    const ambiguous = call("support.create_support_ticket", {
      operation_id: "g7-adopted",
      expected_revision: 1,
    });
    expect(ambiguous.ok).toBe(false);
    expect(registration.session.effectCount()).toBe(0);
    expect(base.effectCount()).toBe(1);

    const reconciled = call("support.get_support_ticket", { operation_id: "g7-adopted" });
    expect(reconciled.ok).toBe(true);
    expect((reconciled.data as Record<string, unknown>).authority).toBe("authoritative");
    // The mirror now agrees with the world instead of under-reporting it.
    expect(registration.session.effectCount()).toBe(1);
    expect(reconciled.effect_count).toBe(1);

    const adoption = registration.protocol
      .allEvents()
      .filter((event) => event.event_type === "discovered_commit_adopted");
    expect(adoption).toHaveLength(1);
  });

  it("G8 still commits once on the honest ordered path", () => {
    const runtime = new SuiteToolRuntime();
    const { call, registration } = harness(runtime);

    observeSupport(call);
    const committed = call("support.create_support_ticket", {
      operation_id: "g8-honest",
      expected_revision: 1,
    });

    expect(committed.ok).toBe(true);
    expect(committed.effect_count).toBe(1);
    expect(registration.session.effectCount()).toBe(1);
    expect(runtime.effectCount()).toBe(1);
    expect(registration.session.latestCheckpoint()?.postconditions_met).toBe(true);
  });
});
