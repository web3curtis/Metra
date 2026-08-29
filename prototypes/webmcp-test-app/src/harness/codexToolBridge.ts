/**
 * Codex ↔ ReliableRail tool bridge.
 * Codex plans; invokeTool executes WebMCP-equivalent tools in-process.
 * IV for generalization = agent profile / execution engine, not mechanisms.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fixture } from "../domain/types.ts";
import {
  EventRecorder,
  invokeTool,
  type ToolName,
} from "../domain/harness.ts";
import { ReliableRailStore } from "../domain/store.ts";
import { evaluateOrderOracle } from "../domain/oracle.ts";
import {
  writeSessionArtifacts,
  type SessionResult,
  type SessionSpec,
} from "./sessionRunner.ts";
import { probeCodexAdapter } from "./codexAgentAdapter.ts";
import type { EffectRecord } from "../../../reliability-boundary/effect/effectSafety.ts";

const TOOL_NAMES: ToolName[] = [
  "search_journeys",
  "select_journey",
  "list_available_seats",
  "reserve_seats",
  "review_order",
  "purchase_tickets",
  "get_order",
  "cancel_draft",
  "reset_fixture",
];

export type CodexBridgeMechanismFlags = {
  contractConformance?: boolean;
  capabilityFreshness?: boolean;
  structuredSemantics?: boolean;
  diagnosisPolicy?: boolean;
  effectSafety?: boolean;
  stateRecovery?: boolean;
};

export type CodexNextAction = {
  done?: boolean;
  tool?: string;
  args?: Record<string, unknown>;
  note?: string;
};

const ACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    done: { type: "boolean" },
    tool: { type: "string" },
    args: { type: "object", additionalProperties: true },
    note: { type: "string" },
  },
};

function parseAction(raw: string): CodexNextAction {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as CodexNextAction;
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]) as CodexNextAction;
    }
    throw new Error(`codex_action_parse_failed: ${trimmed.slice(0, 200)}`);
  }
}

/**
 * Ask Codex for the next tool action given transcript.
 * Uses `codex exec --output-schema` for structured JSON.
 */
export function requestCodexNextAction(input: {
  system: string;
  task: string;
  transcript: string;
  model?: string;
}): CodexNextAction {
  const probe = probeCodexAdapter();
  if (probe.status !== "ready") {
    throw new Error(`codex_adapter_blocked: ${probe.detail}`);
  }

  const dir = mkdtempSync(join(tmpdir(), "rr-codex-"));
  const schemaPath = join(dir, "action.schema.json");
  const outPath = join(dir, "action.json");
  writeFileSync(schemaPath, JSON.stringify(ACTION_SCHEMA), "utf8");

  const prompt = [
    input.system,
    "",
    "TASK:",
    input.task,
    "",
    "TRANSCRIPT (tool results so far):",
    input.transcript || "(empty — start with reset_fixture then search)",
    "",
    "Respond with JSON only matching the schema: either {\"done\":true,\"note\":\"...\"} or {\"tool\":\"<name>\",\"args\":{...}}.",
    `Allowed tools: ${TOOL_NAMES.join(", ")}.`,
    "Never invent journey/seat IDs; only use IDs returned by tools.",
    "Never blind-retry purchase_tickets after failure without get_order / diagnosis.",
    "Finalize exactly once. After successful purchase, call done.",
  ].join("\n");

  try {
    const args = [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--output-schema",
      schemaPath,
      "-o",
      outPath,
      prompt,
    ];
    if (input.model) {
      args.splice(1, 0, "-m", input.model);
    }
    execFileSync("codex", args, {
      encoding: "utf8",
      timeout: 180_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    const raw = readFileSync(outPath, "utf8");
    return parseAction(raw);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export function runCodexToolBridgeSession(options: {
  repoRoot: string;
  fixture: Fixture;
  experiment_id: string;
  repetition_index: number;
  specification: unknown;
  systemPrompt: string;
  taskPrompt: string;
  maxSteps?: number;
  mechanisms?: CodexBridgeMechanismFlags;
  stage_id?: string;
  condition?: "baseline" | "intervention";
}): SessionResult {
  const store = new ReliableRailStore(options.fixture);
  const recorder = new EventRecorder();
  const registry = new Map<string, EffectRecord>();
  const stage = options.stage_id ?? "generalization-codex";
  const maxSteps = options.maxSteps ?? 24;
  const m = options.mechanisms ?? {};
  const invokeOpts = {
    contractConformance: Boolean(m.contractConformance),
    capabilityFreshness: Boolean(m.capabilityFreshness),
    structuredSemantics: Boolean(m.structuredSemantics),
    diagnosisPolicy: Boolean(m.diagnosisPolicy),
    effectSafety: Boolean(m.effectSafety),
    effectRegistry: registry,
  };

  const spec: SessionSpec = {
    experiment_id: options.experiment_id,
    stage_id: stage,
    condition: options.condition ?? "intervention",
    agent_profile_version: "agent.codex-planner.v0",
    prompt_version: "prompt.codex-planner.v0",
    environment_fixture_version: options.fixture.fixture_version,
    mechanism_flags: {
      contract_conformance: invokeOpts.contractConformance,
      capability_freshness: invokeOpts.capabilityFreshness,
      structured_semantics: invokeOpts.structuredSemantics,
      diagnosis_policy: invokeOpts.diagnosisPolicy,
      effect_safety: invokeOpts.effectSafety,
      state_recovery: Boolean(m.stateRecovery),
    },
    adversity_scenario_version: "none",
    repetition_index: options.repetition_index,
    runtime_lane: "codex-tool-bridge-v0",
  };

  recorder.record({
    component: "agent",
    stage,
    event_type: "agent_intent",
    payload: {
      agent_profile_version: "agent.codex-planner.v0",
      execution_engine: "codex-cli-v0",
      note: "Codex plans tool calls; bridge executes invokeTool.",
    },
  });

  const transcript: string[] = [];

  for (let step = 0; step < maxSteps; step += 1) {
    let action: CodexNextAction;
    try {
      action = requestCodexNextAction({
        system: options.systemPrompt,
        task: options.taskPrompt,
        transcript: transcript.join("\n"),
      });
    } catch (err) {
      const order = store.getOrder();
      const oracle = evaluateOrderOracle(options.fixture, order);
      return writeSessionArtifacts({
        repoRoot: options.repoRoot,
        spec,
        specification: options.specification,
        recorder,
        order,
        oracle,
        status: "included-task-failure",
        metrics: { task_success: false, codex_bridge_error: 1 },
        extra: {
          execution_engine: "codex-cli-v0",
          failure: String(err),
          steps: step,
        },
      });
    }

    recorder.record({
      component: "agent",
      stage,
      event_type: "codex_action",
      payload: { step, action },
    });

    if (action.done) {
      break;
    }

    const tool = action.tool as ToolName | undefined;
    if (!tool || !TOOL_NAMES.includes(tool)) {
      transcript.push(`ERROR: invalid tool ${String(action.tool)}`);
      continue;
    }

    const result = invokeTool(
      store,
      recorder,
      tool,
      action.args ?? {},
      stage,
      invokeOpts,
    );
    transcript.push(
      `STEP ${step}: ${tool}(${JSON.stringify(action.args ?? {})}) -> ${JSON.stringify({
        ok: result.ok,
        error: result.error ?? null,
        data: result.data ?? null,
      })}`,
    );

    if (tool === "purchase_tickets" && result.ok) {
      break;
    }
  }

  const order = store.getOrder();
  const oracle = evaluateOrderOracle(options.fixture, order);
  return writeSessionArtifacts({
    repoRoot: options.repoRoot,
    spec,
    specification: options.specification,
    recorder,
    order,
    oracle,
    status: oracle.ok ? "included-success" : "included-task-failure",
    metrics: {
      task_success: oracle.ok,
      duplicate_effect_count:
        order.committed_purchase_count > 1 ? order.committed_purchase_count - 1 : 0,
      committed_purchase_count: order.committed_purchase_count,
    },
    extra: { execution_engine: "codex-cli-v0" },
  });
}
