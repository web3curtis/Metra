import { describe, expect, it } from "vitest";
import type { UseCase } from "../src/lab/catalog.ts";
import { SuiteToolRuntime } from "../src/lab/runtime.ts";
import { registerUseCaseSuite } from "../src/webmcp/registerSuite.ts";

/**
 * Round-6 independent review found four ways the boundary could hand a caller an
 * account it could not stand behind: an unreadable authoritative answer passed off
 * as a resolution, a refusal naming an action but no tool that performs it, an
 * exception escaping while an effect existed, and a still-running operation
 * reported as no effect. Each is pinned here.
 */

type RegisteredTool = { name: string; execute: (args: Record<string, unknown>) => unknown };

type Envelope = Record<string, unknown> & {
  ok?: boolean;
  error?: string;
  data?: Record<string, unknown>;
};

type Runtime = {
  execute: (useCase: UseCase, toolName: string, args: Record<string, unknown>) => unknown;
};

function harness(runtime: Runtime) {
  const registered: RegisteredTool[] = [];
  const fakeDocument = {
    modelContext: { registerTool: (tool: RegisteredTool) => registered.push(tool) },
  } as unknown as Document;
  const registration = registerUseCaseSuite(runtime as unknown as SuiteToolRuntime, fakeDocument);
  const call = (name: string, args: Record<string, unknown> = {}): Envelope => {
    const tool = registered.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`not_registered:${name}`);
    return tool.execute(args) as Envelope;
  };
  return { call, registration };
}

function invokeBase(base: SuiteToolRuntime, useCase: UseCase, toolName: string, args: Record<string, unknown>) {
  return (base as unknown as Runtime).execute(useCase, toolName, args);
}

function observeSupport(call: (name: string, args?: Record<string, unknown>) => Envelope) {
  expect(call("support.search_help").ok).toBe(true);
  expect(call("support.get_customer_context").ok).toBe(true);
}

describe("round-6 assessment regressions", () => {
  it("U1 refuses an authoritative answer it cannot read, and keeps the gate closed", () => {
    const store = new SuiteToolRuntime();
    const runtime: Runtime = {
      execute(useCase, toolName, args) {
        if (toolName === "create_support_ticket") {
          invokeBase(store, useCase, toolName, args);
          return { ok: false, error: "timeout" };
        }
        if (toolName === "get_support_ticket") {
          // Claims authority, then says nothing: no resolution, effect, or record.
          return {
            ok: true,
            data: {
              operation_id: String(args.operation_id),
              authority: "authoritative",
              effect_count: store.effectCount(),
              revision: store.effectCount() + 1,
            },
          };
        }
        return invokeBase(store, useCase, toolName, args);
      },
    };
    const { call, registration } = harness(runtime);

    observeSupport(call);
    const first = call("support.create_support_ticket", { operation_id: "u1-one", expected_revision: 1 });
    expect(first.error).toBe("ambiguous_effect");
    expect(store.effectCount()).toBe(1);

    const malformed = call("support.get_support_ticket", { operation_id: "u1-one" });
    expect(malformed.ok).toBe(false);
    expect(malformed.error).toBe("unreadable_authority");
    // Nothing was resolved, so the obligation to verify is still outstanding.
    expect(registration.protocol.snapshot().decision).not.toBeNull();

    observeSupport(call);
    const second = call("support.create_support_ticket", { operation_id: "u1-two", expected_revision: 2 });
    expect(second.ok).toBe(false);
    // The decisive property: the store did not gain a second effect.
    expect(store.effectCount()).toBe(1);
  });

  it("U2 names a tool that can satisfy every action it demands", () => {
    const { call } = harness(new SuiteToolRuntime() as unknown as Runtime);

    const first = call("support.create_support_ticket", { operation_id: "u2-no-evidence", expected_revision: 1 });
    expect(first.allowed_next_action).toBe("observe");
    expect(first.next_tool).toBe("support.search_help");

    const repeated = call("support.create_support_ticket", { operation_id: "u2-no-evidence", expected_revision: 1 });
    expect(repeated.ok).toBe(false);
    expect(repeated.allowed_next_action).toBe("reobserve");
    // An action with no tool behind it is a dead end, not a next step.
    expect(repeated.next_tool).toBe("support.search_help");

    const invalidReconcile = call("support.get_support_ticket", { operation_id: "short" });
    expect(invalidReconcile.error).toBe("contract_violation");
    expect(invalidReconcile.allowed_next_action).toBe("reconcile");
    expect(invalidReconcile.next_tool).toBe("support.get_support_ticket");
  });

  it("U3 contains a re-entrant call instead of throwing past the envelope", () => {
    const store = new SuiteToolRuntime();
    let registeredCall!: (name: string, args?: Record<string, unknown>) => Envelope;
    let nested: Envelope | null = null;
    const runtime: Runtime = {
      execute(useCase, toolName, args) {
        const result = invokeBase(store, useCase, toolName, args);
        if (toolName === "create_support_ticket") {
          nested = registeredCall("support.get_support_ticket", { operation_id: String(args.operation_id) });
        }
        return result;
      },
    };
    const registered = harness(runtime);
    registeredCall = registered.call;

    observeSupport(registered.call);
    const outer = registered.call("support.create_support_ticket", {
      operation_id: "u3-reentrant",
      expected_revision: 1,
    });

    // The inner call is refused rather than allowed to interleave two runs.
    expect(nested).not.toBeNull();
    expect(nested!.ok).toBe(false);
    expect(nested!.error).toBe("reentrant_call_refused");
    // The outer call still returns an envelope, never a thrown error.
    expect(typeof outer.ok).toBe("boolean");
    expect(outer.allowed_next_action).toBeDefined();
  });

  it("U4 reports an in-flight operation as unknown, never as no effect", () => {
    const releases: Array<() => void> = [];
    const runtime: Runtime = {
      execute(useCase, toolName) {
        const tool = useCase.tools.find((candidate) => candidate.name === toolName)!;
        if (tool.role === "discover" || tool.role === "inspect") {
          return {
            ok: true,
            data: {
              evidence_id: tool.producesEvidence,
              observed_revision: 1,
              revision: 1,
              use_case: useCase.id,
              ...(tool.observation ?? {}),
            },
          };
        }
        // A transport promise whose server-side operation is still running.
        return new Promise((resolve) => releases.push(() => resolve({ ok: true, data: {} })));
      },
    };
    const { call, registration } = harness(runtime);

    observeSupport(call);
    const pending = call("support.create_support_ticket", { operation_id: "u4-in-flight", expected_revision: 1 });

    expect(pending.ok).toBe(false);
    expect(pending.error).toBe("unverifiable_async_effect");
    // "Rejected" would be a guess; the operation may still commit.
    expect(pending.commit_status).toBe("possible");
    expect(pending.allowed_next_action).toBe("reconcile");
    expect(pending.next_tool).toBe("support.get_support_ticket");
    expect(registration.session.effectCount()).toBe(0);
    expect(releases).toHaveLength(1);
  });
});
