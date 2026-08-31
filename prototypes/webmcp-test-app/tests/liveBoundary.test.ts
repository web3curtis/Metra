/**
 * Independent live-boundary falsifier.
 *
 * Reproduces CURSOR_HANDOVER_RUNTIME_FAILURE_001 exactly through the registered
 * WebMCP path (document.modelContext.registerTool -> execute), never by calling
 * SuiteToolRuntime directly. Emits machine-readable evidence for Codex.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SuiteToolRuntime } from "../src/lab/runtime.ts";
import { registerUseCaseSuite } from "../src/webmcp/registerSuite.ts";

type RegisteredTool = {
  name: string;
  description: string;
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

const EVIDENCE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../.falsifier-evidence");

function registerNativeSuite() {
  const registered: RegisteredTool[] = [];
  const fakeDocument = {
    modelContext: {
      registerTool(tool: RegisteredTool) {
        registered.push(tool);
      },
    },
  } as unknown as Document;
  const runtime = new SuiteToolRuntime();
  const registration = registerUseCaseSuite(runtime, fakeDocument);
  const call = (name: string, args: Record<string, unknown> = {}): Envelope => {
    const tool = registered.find((item) => item.name === name);
    if (!tool) throw new Error(`tool_not_registered:${name}`);
    return tool.execute(args) as Envelope;
  };
  return { registered, runtime, registration, call };
}

const transcript: Array<Record<string, unknown>> = [];

function log(step: string, call: string, args: Record<string, unknown>, result: unknown) {
  transcript.push({ step, call, args, result });
}

describe("live registered-path falsifier", () => {
  it("F0 never reaches the domain handler on a premature consequential call", () => {
    const reached: string[] = [];
    const registered: RegisteredTool[] = [];
    const fakeDocument = {
      modelContext: {
        registerTool(tool: RegisteredTool) {
          registered.push(tool);
        },
      },
    } as unknown as Document;

    // Instrumented runtime: any dispatch that gets this far is recorded.
    const runtime = new SuiteToolRuntime();
    const spy = {
      execute(useCase: { id: string }, toolName: string, args: Record<string, unknown>) {
        reached.push(`${useCase.id}.${toolName}`);
        return (runtime as unknown as { execute: (u: unknown, t: string, a: unknown) => unknown }).execute(useCase, toolName, args);
      },
    } as unknown as SuiteToolRuntime;
    registerUseCaseSuite(spy, fakeDocument);

    const create = registered.find((item) => item.name === "support.create_support_ticket")!;
    const premature = create.execute({ operation_id: "codex-premature-001", expected_revision: 1 }) as Envelope;
    log("F0_handler_never_reached", "support.create_support_ticket", { operation_id: "codex-premature-001", expected_revision: 1 }, {
      envelope: premature,
      handler_invocations: reached,
    });

    expect(premature.ok).toBe(false);
    expect(reached).toEqual([]);
    expect(runtime.effectCount()).toBe(0);
  });

  it("F1 rejects the premature support ticket with zero effects", () => {
    const { runtime, call, registered } = registerNativeSuite();
    expect(registered).toHaveLength(24);

    const premature = call("support.create_support_ticket", {
      operation_id: "codex-premature-001",
      expected_revision: 1,
    });
    log("F1_premature_act", "support.create_support_ticket", { operation_id: "codex-premature-001", expected_revision: 1 }, premature);

    expect(premature.ok).toBe(false);
    expect(runtime.effectCount()).toBe(0);
    expect(premature.effect_count).toBe(0);
    // Must name a structured precondition failure, not an opaque error.
    expect(String(premature.error)).toMatch(/precondition|contract/);
    // Must name both missing observations.
    expect(premature.missing_evidence).toEqual([
      "support.verified_help",
      "support.customer_context",
    ]);
    // Must offer exactly one legal next action.
    expect(premature.allowed_next_action).toBe("observe");
    expect(String(premature.next_tool)).toContain("support.search_help");
  });

  it("F2 completes the valid ordered support path exactly once", () => {
    const { runtime, call } = registerNativeSuite();

    const help = call("support.search_help", {});
    log("F2_observe_help", "support.search_help", {}, help);
    expect(help.ok).toBe(true);

    const context = call("support.get_customer_context", {});
    log("F2_observe_context", "support.get_customer_context", {}, context);
    expect(context.ok).toBe(true);

    const committed = call("support.create_support_ticket", {
      operation_id: "codex-ordered-001",
      expected_revision: 1,
    });
    log("F2_act", "support.create_support_ticket", { operation_id: "codex-ordered-001", expected_revision: 1 }, committed);

    expect(committed.ok).toBe(true);
    expect(runtime.effectCount()).toBe(1);
    expect((committed.data as Record<string, unknown>)?.effect_count).toBe(1);
  });

  it("F3 reconciles the authoritative record by operation_id", () => {
    const { call } = registerNativeSuite();
    call("support.search_help", {});
    call("support.get_customer_context", {});
    call("support.create_support_ticket", { operation_id: "codex-recon-001", expected_revision: 1 });

    const reconciled = call("support.get_support_ticket", { operation_id: "codex-recon-001" });
    log("F3_reconcile", "support.get_support_ticket", { operation_id: "codex-recon-001" }, reconciled);

    expect(reconciled.ok).toBe(true);
    const data = reconciled.data as Record<string, unknown>;
    expect(data.operation_id).toBe("codex-recon-001");
    expect(data.authority).toBe("authoritative");
    expect(data.effect_count).toBe(1);
    expect(data.record).toBeTruthy();
  });

  it("F4 never duplicates on retry of the same operation_id", () => {
    const { runtime, call } = registerNativeSuite();
    call("support.search_help", {});
    call("support.get_customer_context", {});
    const first = call("support.create_support_ticket", { operation_id: "codex-dup-001", expected_revision: 1 });
    expect(first.ok).toBe(true);

    // A committed effect must be verified before any further consequential call.
    const retry = call("support.create_support_ticket", { operation_id: "codex-dup-001", expected_revision: 1 });
    log("F4_retry_same_operation", "support.create_support_ticket", { operation_id: "codex-dup-001", expected_revision: 1 }, retry);
    expect(retry.ok).toBe(false);
    expect(runtime.effectCount()).toBe(1);

    const authoritative = call("support.get_support_ticket", { operation_id: "codex-dup-001" });
    log("F4_reconcile_after_retry", "support.get_support_ticket", { operation_id: "codex-dup-001" }, authoritative);
    expect(authoritative.ok).toBe(true);
    expect((authoritative.data as Record<string, unknown>)?.effect_count).toBe(1);
    expect(runtime.effectCount()).toBe(1);
  });

  it("F5 blocks a second effect made on stale evidence", () => {
    const { runtime, call } = registerNativeSuite();
    call("support.search_help", {});
    call("support.get_customer_context", {});
    call("support.create_support_ticket", { operation_id: "codex-stale-a", expected_revision: 1 });
    expect(runtime.effectCount()).toBe(1);

    // Evidence observed at revision 1 is now stale; a NEW operation must not commit.
    const stale = call("support.create_support_ticket", { operation_id: "codex-stale-b", expected_revision: 1 });
    log("F5_stale_second_effect", "support.create_support_ticket", { operation_id: "codex-stale-b", expected_revision: 1 }, stale);

    expect(stale.ok).toBe(false);
    expect(runtime.effectCount()).toBe(1);
  });

  it("F7 refuses a coercible but wrongly typed expected_revision", () => {
    const { runtime, call } = registerNativeSuite();
    call("support.search_help", {});
    call("support.get_customer_context", {});

    // The declared schema says integer. A string that Number() would happily
    // coerce to 1 must still fail the contract rather than commit.
    const coerced = call("support.create_support_ticket", {
      operation_id: "codex-coerce-001",
      expected_revision: "1",
    });
    log("F7_coerced_revision", "support.create_support_ticket", { operation_id: "codex-coerce-001", expected_revision: "1" }, coerced);

    expect(coerced.ok).toBe(false);
    expect(coerced.error).toBe("contract_violation");
    expect(runtime.effectCount()).toBe(0);
    // A contract violation is not self-healing; the only legal move is to stop.
    expect(coerced.allowed_next_action).toBe("stop");

    // The same sequence with a genuine integer commits, so the rejection above
    // is caused by the type and not by the ordering.
    const fresh = registerNativeSuite();
    fresh.call("support.search_help", {});
    fresh.call("support.get_customer_context", {});
    const valid = fresh.call("support.create_support_ticket", {
      operation_id: "codex-coerce-002",
      expected_revision: 1,
    });
    expect(valid.ok).toBe(true);
    expect(fresh.runtime.effectCount()).toBe(1);
  });

  // Regression for CURSOR_HANDOVER_RUNTIME_FAILURE_002: a handler that reports a
  // commit without making one must not produce a commit at the boundary either.
  it("F8 refuses a counterfeit success that authority cannot confirm", () => {
    const registered: RegisteredTool[] = [];
    const fakeDocument = {
      modelContext: {
        registerTool(tool: RegisteredTool) {
          registered.push(tool);
        },
      },
    } as unknown as Document;

    const runtime = new SuiteToolRuntime();
    const counterfeit = {
      execute(useCase: { id: string }, toolName: string, args: Record<string, unknown>) {
        if (toolName === "create_support_ticket") {
          return {
            ok: true,
            data: {
              id: "counterfeit-ticket",
              effect_id: "counterfeit-ticket",
              status: "committed",
              priority: "P2",
              operation_id: String(args.operation_id),
              revision: 2,
              effect_count: 1,
              record: { record_type: "support_ticket", priority: "P2" },
              simulated: true,
            },
          };
        }
        return (runtime as unknown as { execute: (u: unknown, t: string, a: unknown) => unknown }).execute(useCase, toolName, args);
      },
    } as unknown as SuiteToolRuntime;

    const registration = registerUseCaseSuite(counterfeit, fakeDocument);
    const call = (name: string, args: Record<string, unknown> = {}) =>
      registered.find((item) => item.name === name)!.execute(args) as Envelope;

    call("support.search_help");
    call("support.get_customer_context");
    const claimed = call("support.create_support_ticket", {
      operation_id: "codex-counterfeit-001",
      expected_revision: 1,
    });
    log("F8_counterfeit_success", "support.create_support_ticket", { operation_id: "codex-counterfeit-001" }, claimed);

    expect(claimed.ok).toBe(false);
    expect(claimed.error).toBe("unverified_effect");
    expect(claimed.effect_count).toBe(0);
    expect(claimed.commit_status).toBe("possible");
    expect(claimed.authority).toBe("unavailable");
    expect(claimed.allowed_next_action).toBe("reconcile");
    expect(registration.session.effectCount()).toBe(0);
    expect(runtime.effectCount()).toBe(0);
    // No checkpoint may assert that postconditions were met.
    expect(registration.session.latestCheckpoint()?.postconditions_met).toBe(false);

    const authoritative = call("support.get_support_ticket", { operation_id: "codex-counterfeit-001" });
    expect(authoritative.effect_count).toBe(0);
    // Authority is reachable and says plainly that the claimed ticket never existed.
    expect((authoritative.data as Record<string, unknown>).resolution).toBe("absent");
  });

  it("F6 exposes A-D2 mechanism evidence in one live trace", () => {
    const { call, registration, runtime } = registerNativeSuite();
    call("support.create_support_ticket", { operation_id: "codex-trace-001", expected_revision: 1 });
    call("support.search_help", {});
    call("support.get_customer_context", {});
    call("support.create_support_ticket", { operation_id: "codex-trace-001", expected_revision: 1 });
    call("support.get_support_ticket", { operation_id: "codex-trace-001" });

    const events = registration.protocol.allEvents();
    const mechanisms = new Set(
      events.map((event) => event.payload.mechanism).filter((value): value is string => typeof value === "string"),
    );
    log("F6_trace", "protocol.allEvents", {}, {
      event_count: events.length,
      mechanisms: [...mechanisms].sort(),
      events,
    });

    for (const mechanism of ["A", "B", "C1", "C2", "D1", "D2"]) {
      expect([...mechanisms]).toContain(mechanism);
    }
    expect(runtime.effectCount()).toBe(1);
    expect(registration.session.effectCount()).toBe(1);
    expect(registration.session.latestCheckpoint()?.postconditions_met).toBe(true);

    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(join(EVIDENCE_DIR, "live-falsifier-transcript.json"), JSON.stringify(transcript, null, 2));
    writeFileSync(join(EVIDENCE_DIR, "live-falsifier-trace.jsonl"), registration.protocol.toJsonl());

    expect(events.length).toBeGreaterThan(0);
  });
});
