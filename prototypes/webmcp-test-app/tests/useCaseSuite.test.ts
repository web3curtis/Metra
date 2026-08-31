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
    const action = useCase.tools.find((tool) => !tool.readOnly)!;
    const stale = runtime.execute(useCase, action.name, {
      operation_id: "op_stale",
      expected_revision: 2,
    });
    expect(stale).toMatchObject({ ok: false, error: "stale_revision" });

    const first = runtime.execute(useCase, action.name, {
      operation_id: "op_fixed",
      expected_revision: 1,
    });
    expect(first).toMatchObject({ ok: true });
    const duplicate = runtime.execute(useCase, action.name, {
      operation_id: "op_fixed",
      expected_revision: 2,
    });
    expect(duplicate).toMatchObject({ ok: true, data: { duplicate_prevented: true } });
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
