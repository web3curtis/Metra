import { describe, expect, it } from "vitest";
import { USE_CASES } from "../src/lab/catalog.ts";
import { runComparison, SuiteToolRuntime } from "../src/lab/runtime.ts";
import { createRecording } from "../src/lab/runtime.ts";
import { auditComparison } from "../src/lab/audit.ts";
import { registerUseCaseSuite } from "../src/webmcp/registerSuite.ts";

describe("WebMCP use-case suite", () => {
  it("defines six domains with four typed tools each", () => {
    expect(USE_CASES).toHaveLength(6);
    for (const useCase of USE_CASES) {
      expect(useCase.tools).toHaveLength(4);
      expect(useCase.tools.filter((tool) => !tool.readOnly)).toHaveLength(1);
      expect(new Set(useCase.tools.map((tool) => tool.name)).size).toBe(4);
      expect(useCase.userPrompt.length).toBeGreaterThan(80);
      expect(useCase.startContext.length).toBeGreaterThan(60);
      expect(useCase.startUrl).toMatch(/^https:\/\//);
    }
  });

  it("records both lanes on one synchronized frame clock", () => {
    const result = runComparison(USE_CASES[0]!);
    const recording = createRecording(result, 800);
    expect(recording.frames[0]).toMatchObject({ rawTraceCount: 0, guidedTraceCount: 0 });
    expect(recording.frames.at(-1)?.rawTraceCount).toBe(result.raw.trace.length);
    expect(recording.frames.at(-1)?.guidedTraceCount).toBe(result.guided.trace.length);
    expect(recording.durationMs).toBeGreaterThan(0);
  });

  it("audits raw and prototype separately after a valid matched run", () => {
    for (const useCase of USE_CASES) {
      const result = runComparison(useCase);
      const audit = auditComparison(useCase, result);
      expect(audit.valid).toBe(true);
      expect(audit.verdict).toBe("VALID_IMPROVEMENT");
      expect(audit.raw.verdict).toBe("FAIL");
      expect(audit.guided.verdict).toBe("PASS");
      expect(audit.guided.score).toBe(100);
      expect(audit.parity.every((item) => item.status === "pass")).toBe(true);
    }
  });

  it("guided direction passes every adversity with exactly one effect", () => {
    for (const useCase of USE_CASES) {
      const result = runComparison(useCase);
      expect(result.comparisonValid).toBe(true);
      expect(result.guided.verdict).toBe("PASS");
      expect(result.guided.effectCount).toBe(1);
      expect(result.guided.trace.at(-1)?.step).toBe("stop");
      expect(result.raw.verdict).toBe("FAIL");
    }
  });

  it("enforces revision and idempotency at the tool runtime", () => {
    const runtime = new SuiteToolRuntime();
    const useCase = USE_CASES[0]!;
    const [discover, inspect, action] = useCase.tools;
    expect(discover && inspect && action && !action.readOnly).toBe(true);

    runtime.execute(useCase, discover!.name, {});
    runtime.execute(useCase, inspect!.name, {});

    const stale = runtime.execute(useCase, action!.name, {
      operation_id: "op_stale",
      expected_revision: 2,
    });
    expect(stale).toMatchObject({ ok: false, error: "stale_revision" });

    const first = runtime.execute(useCase, action!.name, {
      operation_id: "op_fixed",
      expected_revision: 1,
    });
    expect(first).toMatchObject({ ok: true });
    const duplicate = runtime.execute(useCase, action!.name, {
      operation_id: "op_fixed",
      expected_revision: 2,
    });
    expect(duplicate).toMatchObject({ ok: true, data: { duplicate_prevented: true } });
  });

  it("blocks premature support ticket with zero effects", () => {
    const runtime = new SuiteToolRuntime();
    const support = USE_CASES.find((item) => item.id === "support")!;
    const premature = runtime.execute(support, "create_support_ticket", {
      operation_id: "codex-premature-001",
      expected_revision: 1,
    });
    expect(premature).toMatchObject({
      ok: false,
      error: "invalid_precondition",
      effect_count: 0,
      allowed_next_action: "observe",
    });
    expect((premature as { missing_evidence?: string[] }).missing_evidence).toEqual([
      "support.verified_help",
      "support.customer_context",
    ]);
    expect(runtime.effectCount()).toBe(0);

    runtime.execute(support, "search_help", {});
    runtime.execute(support, "get_customer_context", {});
    const committed = runtime.execute(support, "create_support_ticket", {
      operation_id: "codex-premature-001",
      expected_revision: 1,
    });
    expect(committed).toMatchObject({ ok: true, data: { effect_count: 1 } });

    const reconciled = runtime.execute(support, "get_support_ticket", {
      operation_id: "codex-premature-001",
    });
    expect(reconciled).toMatchObject({
      ok: true,
      data: {
        operation_id: "codex-premature-001",
        authority: "authoritative",
        effect_count: 1,
      },
    });
  });

  it("registers the support falsifier on the native WebMCP path", () => {
    const definitions: Array<{ name: string; execute: (args: Record<string, unknown>) => unknown }> = [];
    const fakeDocument = {
      modelContext: {
        registerTool(definition: typeof definitions[number]) {
          definitions.push(definition);
        },
      },
    } as unknown as Document;
    const runtime = new SuiteToolRuntime();
    registerUseCaseSuite(runtime, fakeDocument);
    const create = definitions.find((item) => item.name === "support.create_support_ticket");
    expect(create).toBeTruthy();
    const premature = create!.execute({
      operation_id: "codex-premature-001",
      expected_revision: 1,
    }) as { ok: boolean; effect_count?: number };
    expect(premature.ok).toBe(false);
    expect(premature.effect_count ?? runtime.effectCount()).toBe(0);
  });

  it("registers all 24 tools on the native API surface", () => {
    const definitions: Array<{ name: string; execute: (args: Record<string, unknown>) => unknown }> = [];
    const fakeDocument = {
      modelContext: {
        registerTool(definition: typeof definitions[number]) {
          definitions.push(definition);
        },
      },
    } as unknown as Document;
    const result = registerUseCaseSuite(new SuiteToolRuntime(), fakeDocument);
    expect(result.lane).toBe("native");
    expect(result.registered).toHaveLength(24);
    expect(definitions[0]?.name).toBe("commerce.search_products");
  });
});
