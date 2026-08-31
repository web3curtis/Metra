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
import { USE_CASES } from "../src/lab/catalog.ts";
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
];

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
  transcript: Array<{ tool: string; ok: boolean; note: string }>;
};

function runRaw(scenario: Scenario): LaneOutcome {
  const tools: RegisteredTool[] = [];
  const runtime = new RawSuiteRuntime();
  registerRawSuite(runtime, fakeDocument(tools), USE_CASES);

  const transcript: LaneOutcome["transcript"] = [];
  let blocked = 0;
  for (const call of scenario.calls) {
    const tool = tools.find((item) => item.name === call.tool)!;
    const result = tool.execute(call.args) as Envelope;
    const ok = Boolean(result.ok);
    if (!ok) blocked += 1;
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
    transcript,
  };
}

function runPrototype(scenario: Scenario): LaneOutcome {
  const tools: RegisteredTool[] = [];
  const runtime = new SuiteToolRuntime();
  registerUseCaseSuite(runtime, fakeDocument(tools));

  const transcript: LaneOutcome["transcript"] = [];
  let blocked = 0;
  let nextAction: string | null = null;
  for (const call of scenario.calls) {
    const tool = tools.find((item) => item.name === call.tool)!;
    const result = tool.execute(call.args) as Envelope;
    const ok = Boolean(result.ok);
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
    }
    expect(rows.some((row) => !row.raw.correct)).toBe(true);

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
    lines.push("| Scenario | Correct effects | Raw effects | Prototype effects | Raw verdict | Prototype verdict |");
    lines.push("|---|---:|---:|---:|---|---|");
    for (const { scenario, raw, prototype } of rows) {
      lines.push(
        `| ${scenario.id} ${scenario.title} | ${scenario.correctEffectCount} | ${raw.effect_count} | ${prototype.effect_count} | ${raw.correct ? "correct" : "**wrong**"} | ${prototype.correct ? "correct" : "**wrong**"} |`,
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
      lines.push("```");
      lines.push("");
      lines.push("### Metra prototype");
      lines.push("");
      lines.push("```text");
      for (const step of prototype.transcript) lines.push(`${step.ok ? "ok  " : "fail"} ${step.tool} — ${step.note}`);
      lines.push(`result: ${prototype.effect_count} effect(s) — ${prototype.correct ? "correct" : "WRONG"}`);
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
