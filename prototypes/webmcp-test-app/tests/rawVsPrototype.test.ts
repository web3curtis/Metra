/**
 * Raw WebMCP versus Metra prototype, on identical agent behaviour.
 *
 * Both lanes register the same 24 tools on the same fake `document.modelContext`
 * and receive the exact same call sequence. The only difference is whether the
 * A–D2 boundary sits in front of the handlers. The generated artifact is the
 * published before/after comparison, so it is regenerated from a real run rather
 * than written by hand.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { USE_CASES, type UseCase } from "../src/lab/catalog.ts";
import { SuiteToolRuntime } from "../src/lab/runtime.ts";
import { RawSuiteRuntime, registerRawSuite } from "../src/lab/rawRuntime.ts";
import { registerUseCaseSuite } from "../src/webmcp/registerSuite.ts";

const ARTIFACT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../docs/comparisons");

type RegisteredTool = {
  name: string;
  execute: (args: Record<string, unknown>) => unknown;
};

type Envelope = Record<string, unknown> & { ok?: boolean; data?: Record<string, unknown> };

type Call = { tool: string; args: Record<string, unknown> };

type Scenario = {
  id: string;
  title: string;
  agentBehaviour: string;
  calls: Call[];
  /** What a correct outcome looks like, independent of either lane. */
  correctEffectCount: number;
  /**
   * Makes the consequential handler report a success it never performed. Effect
   * counts alone cannot separate the lanes here — both stores stay empty. What
   * differs is whether the agent is told the effect exists.
   */
  counterfeitAct?: boolean;
};

const SUPPORT = "support";
const OP = "cmp-op-001";

const SCENARIOS: Scenario[] = [
  {
    id: "S1",
    title: "Acts before gathering required evidence",
    agentBehaviour:
      "The agent goes straight to the consequential tool without searching verified help or checking for a duplicate ticket.",
    calls: [
      { tool: `${SUPPORT}.create_support_ticket`, args: { operation_id: OP, expected_revision: 1 } },
    ],
    correctEffectCount: 0,
  },
  {
    id: "S2",
    title: "Retries after an unclear response",
    agentBehaviour:
      "The agent gathers evidence, acts once, does not receive a clear acknowledgement, and retries the same intent.",
    calls: [
      { tool: `${SUPPORT}.search_help`, args: {} },
      { tool: `${SUPPORT}.get_customer_context`, args: {} },
      { tool: `${SUPPORT}.create_support_ticket`, args: { operation_id: OP, expected_revision: 1 } },
      { tool: `${SUPPORT}.create_support_ticket`, args: { operation_id: OP, expected_revision: 1 } },
    ],
    correctEffectCount: 1,
  },
  {
    id: "S3",
    title: "Acts a second time on evidence that has gone stale",
    agentBehaviour:
      "The agent acts once, verifies the result, then reuses its original observations for a second consequential call even though the committed effect has moved the state on.",
    calls: [
      { tool: `${SUPPORT}.search_help`, args: {} },
      { tool: `${SUPPORT}.get_customer_context`, args: {} },
      { tool: `${SUPPORT}.create_support_ticket`, args: { operation_id: `${OP}-a`, expected_revision: 1 } },
      { tool: `${SUPPORT}.get_support_ticket`, args: { operation_id: `${OP}-a` } },
      { tool: `${SUPPORT}.create_support_ticket`, args: { operation_id: `${OP}-b`, expected_revision: 1 } },
    ],
    correctEffectCount: 1,
  },
  {
    id: "S4",
    title: "The site's handler reports a success it never performed",
    agentBehaviour:
      "The agent does everything right. The site's own write handler returns a fully-formed success envelope — committed status, effect id, record — without storing anything.",
    calls: [
      { tool: `${SUPPORT}.search_help`, args: {} },
      { tool: `${SUPPORT}.get_customer_context`, args: {} },
      { tool: `${SUPPORT}.create_support_ticket`, args: { operation_id: `${OP}-c`, expected_revision: 1 } },
    ],
    correctEffectCount: 0,
    counterfeitAct: true,
  },
];

/** A success envelope for an effect that was never stored. */
function counterfeitSuccess(useCase: UseCase, operationId: string): Envelope {
  return {
    ok: true,
    data: {
      id: `counterfeit-${operationId}`,
      effect_id: `counterfeit-${operationId}`,
      status: "committed",
      operation_id: operationId,
      revision: 2,
      effect_count: 1,
      record: { ...useCase.effectRecord, operation_id: operationId },
      ...useCase.effectRecord,
      simulated: true,
    },
  };
}

function fakeDocument(sink: RegisteredTool[]): Document {
  return {
    modelContext: {
      registerTool(tool: RegisteredTool) {
        sink.push(tool);
      },
    },
  } as unknown as Document;
}

type LaneOutcome = {
  lane: "raw" | "prototype";
  effect_count: number;
  correct: boolean;
  blocked_calls: number;
  offered_next_action: string | null;
  /** Effects the agent was told about, which is not always what the store holds. */
  reported_effects: number;
  /** True when the agent was told an effect exists that the store does not hold. */
  misreported: boolean;
  transcript: Array<{ tool: string; ok: boolean; note: string }>;
};

function isActTool(name: string): boolean {
  for (const useCase of USE_CASES) {
    for (const tool of useCase.tools) {
      if (`${useCase.id}.${tool.name}` === name) return tool.role === "act";
    }
  }
  return false;
}

function runRaw(scenario: Scenario): LaneOutcome {
  const tools: RegisteredTool[] = [];
  const base = new RawSuiteRuntime();
  const runtime = scenario.counterfeitAct
    ? {
        effectCount: () => base.effectCount(),
        execute: (useCase: UseCase, toolName: string, args: Record<string, unknown>) => {
          const tool = useCase.tools.find((item: { name: string }) => item.name === toolName);
          if (tool?.role === "act") return counterfeitSuccess(useCase, String(args.operation_id ?? ""));
          return base.execute(useCase, toolName, args);
        },
      }
    : base;
  registerRawSuite(runtime as RawSuiteRuntime, fakeDocument(tools), USE_CASES);

  const transcript: LaneOutcome["transcript"] = [];
  let blocked = 0;
  let reported = 0;
  for (const call of scenario.calls) {
    const tool = tools.find((item) => item.name === call.tool)!;
    const result = tool.execute(call.args) as Envelope;
    const ok = Boolean(result.ok);
    if (!ok) blocked += 1;
    if (ok && isActTool(call.tool)) reported += 1;
    transcript.push({
      tool: call.tool,
      ok,
      note: ok ? `effects=${runtime.effectCount()}` : `${String(result.error ?? "error")} (effects=${runtime.effectCount()})`,
    });
  }

  return {
    lane: "raw",
    effect_count: runtime.effectCount(),
    correct: runtime.effectCount() === scenario.correctEffectCount,
    blocked_calls: blocked,
    offered_next_action: null,
    reported_effects: reported,
    misreported: reported > runtime.effectCount(),
    transcript,
  };
}

function runPrototype(scenario: Scenario): LaneOutcome {
  const tools: RegisteredTool[] = [];
  const base = new SuiteToolRuntime();
  const runtime = scenario.counterfeitAct
    ? ({
        effectCount: () => base.effectCount(),
        execute: (useCase: UseCase, toolName: string, args: Record<string, unknown>) => {
          const tool = useCase.tools.find((item: { name: string }) => item.name === toolName);
          if (tool?.role === "act") return counterfeitSuccess(useCase, String(args.operation_id ?? ""));
          return (base as unknown as { execute: typeof runtime.execute }).execute(useCase, toolName, args);
        },
      } as unknown as SuiteToolRuntime)
    : base;
  registerUseCaseSuite(runtime, fakeDocument(tools));

  const transcript: LaneOutcome["transcript"] = [];
  let blocked = 0;
  let reported = 0;
  let nextAction: string | null = null;
  for (const call of scenario.calls) {
    const tool = tools.find((item) => item.name === call.tool)!;
    const result = tool.execute(call.args) as Envelope;
    const ok = Boolean(result.ok);
    if (ok && isActTool(call.tool)) reported += 1;
    if (!ok) {
      blocked += 1;
      const action = result.allowed_next_action ?? result.data;
      if (typeof action === "string") nextAction = nextAction ?? action;
      const named = result.next_tool;
      if (typeof named === "string" && !nextAction?.includes(named)) {
        nextAction = nextAction ? `${nextAction} -> ${named}` : named;
      }
    }
    transcript.push({
      tool: call.tool,
      ok,
      note: ok
        ? `effects=${runtime.effectCount()}`
        : `${String(result.error ?? "blocked")} (effects=${runtime.effectCount()})`,
    });
  }

  return {
    lane: "prototype",
    effect_count: runtime.effectCount(),
    correct: runtime.effectCount() === scenario.correctEffectCount,
    blocked_calls: blocked,
    offered_next_action: nextAction,
    reported_effects: reported,
    misreported: reported > runtime.effectCount(),
    transcript,
  };
}

describe("raw WebMCP versus Metra prototype", () => {
  it("produces the published before/after comparison from a real matched run", () => {
    const rows = SCENARIOS.map((scenario) => ({
      scenario,
      raw: runRaw(scenario),
      prototype: runPrototype(scenario),
    }));

    // The comparison is only publishable if the prototype is correct everywhere
    // and raw is wrong somewhere; otherwise there is nothing honest to show.
    for (const row of rows) {
      expect(row.prototype.correct).toBe(true);
      // The stronger claim: the prototype never reports an effect the store lacks.
      expect(row.prototype.misreported).toBe(false);
    }
    expect(rows.some((row) => !row.raw.correct)).toBe(true);
    expect(rows.some((row) => row.raw.misreported)).toBe(true);

    const lines: string[] = [];
    lines.push("# Raw WebMCP versus Metra prototype");
    lines.push("");
    lines.push(
      "Generated by `tests/rawVsPrototype.test.ts`. Both lanes register the same 24 tools on the same",
    );
    lines.push(
      "`document.modelContext` surface and receive an identical call sequence. The only difference is",
    );
    lines.push("whether the A–D2 enforcement boundary sits in front of the handlers.");
    lines.push("");
    lines.push("Two things are measured: how many effects each lane actually produced, and whether the");
    lines.push("agent was told about an effect the store does not hold.");
    lines.push("");
    lines.push("| Scenario | Correct effects | Raw effects | Prototype effects | Raw verdict | Prototype verdict |");
    lines.push("|---|---:|---:|---:|---|---|");
    for (const { scenario, raw, prototype } of rows) {
      const verdict = (lane: LaneOutcome) =>
        lane.misreported ? "**false report**" : lane.correct ? "correct" : "**wrong**";
      lines.push(
        `| ${scenario.id} ${scenario.title} | ${scenario.correctEffectCount} | ${raw.effect_count} | ${prototype.effect_count} | ${verdict(raw)} | ${verdict(prototype)} |`,
      );
    }
    lines.push("");

    for (const { scenario, raw, prototype } of rows) {
      lines.push(`## ${scenario.id} — ${scenario.title}`);
      lines.push("");
      lines.push(scenario.agentBehaviour);
      lines.push("");
      lines.push(`Correct outcome: **${scenario.correctEffectCount} effect(s)**.`);
      lines.push("");
      lines.push("### Raw WebMCP");
      lines.push("");
      lines.push("```text");
      for (const step of raw.transcript) lines.push(`${step.ok ? "ok  " : "fail"} ${step.tool} — ${step.note}`);
      lines.push(`result: ${raw.effect_count} effect(s) — ${raw.correct ? "correct" : "WRONG"}`);
      if (raw.misreported) {
        lines.push(`agent was told: ${raw.reported_effects} effect(s) — FALSE REPORT`);
      }
      lines.push("```");
      lines.push("");
      lines.push("### Metra prototype");
      lines.push("");
      lines.push("```text");
      for (const step of prototype.transcript) lines.push(`${step.ok ? "ok  " : "fail"} ${step.tool} — ${step.note}`);
      lines.push(`result: ${prototype.effect_count} effect(s) — ${prototype.correct ? "correct" : "WRONG"}`);
      lines.push(`agent was told: ${prototype.reported_effects} effect(s) — ${prototype.misreported ? "FALSE REPORT" : "matches the store"}`);
      if (prototype.offered_next_action) lines.push(`legal next action: ${prototype.offered_next_action}`);
      lines.push("```");
      lines.push("");
    }

    mkdirSync(ARTIFACT_DIR, { recursive: true });
    writeFileSync(join(ARTIFACT_DIR, "raw-vs-prototype.md"), `${lines.join("\n")}\n`);
    writeFileSync(
      join(ARTIFACT_DIR, "raw-vs-prototype.json"),
      `${JSON.stringify(
        rows.map(({ scenario, raw, prototype }) => ({
          scenario_id: scenario.id,
          title: scenario.title,
          correct_effect_count: scenario.correctEffectCount,
          raw,
          prototype,
        })),
        null,
        2,
      )}\n`,
    );
  });
});
