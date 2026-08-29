import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Fixture, OrderSnapshot } from "../domain/types.ts";
import { ReliableRailStore } from "../domain/store.ts";
import { EventRecorder, runScriptedHappyPath } from "../domain/harness.ts";
import { evaluateOrderOracle } from "../domain/oracle.ts";

export type SessionSpec = {
  experiment_id: string;
  stage_id: string;
  condition: "apparatus" | "baseline" | "intervention";
  agent_profile_version: string;
  prompt_version: string;
  environment_fixture_version: string;
  mechanism_flags: Record<string, boolean>;
  adversity_scenario_version: string;
  repetition_index: number;
  runtime_lane: string;
};

export type SessionResult = {
  run_id: string;
  status:
    | "included-success"
    | "included-task-failure"
    | "included-safe-failure"
    | "invalid-apparatus";
  order: OrderSnapshot;
  oracle_ok: boolean;
  oracle_reasons: string[];
  metrics: Record<string, number | boolean>;
  artifact_dir: string;
};

function runId(spec: SessionSpec, suffix: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${spec.experiment_id}_${spec.condition}_r${spec.repetition_index}_${suffix}_${ts}`;
}

export function writeSessionArtifacts(options: {
  repoRoot: string;
  spec: SessionSpec;
  specification: unknown;
  recorder: EventRecorder;
  order: OrderSnapshot;
  oracle: ReturnType<typeof evaluateOrderOracle>;
  metrics: Record<string, number | boolean>;
  status: SessionResult["status"];
  extra?: Record<string, unknown>;
}): SessionResult {
  const run_id = runId(options.spec, options.status);
  const artifact_dir = join(
    options.repoRoot,
    "artifacts/experiments",
    options.spec.experiment_id,
    options.spec.condition,
    run_id,
  );
  mkdirSync(artifact_dir, { recursive: true });

  writeFileSync(
    join(artifact_dir, "specification.json"),
    JSON.stringify({ ...options.spec, full: options.specification }, null, 2),
  );
  writeFileSync(join(artifact_dir, "events.jsonl"), options.recorder.toJsonl());
  writeFileSync(
    join(artifact_dir, "final-state.json"),
    JSON.stringify(
      {
        order: options.order,
        oracle: {
          ok: options.oracle.ok,
          reasons: options.oracle.reasons,
          committed_purchase_count: options.oracle.committed_purchase_count,
          state: options.oracle.state,
        },
        status: options.status,
        extra: options.extra ?? {},
      },
      null,
      2,
    ),
  );
  writeFileSync(join(artifact_dir, "metrics.json"), JSON.stringify(options.metrics, null, 2));
  writeFileSync(
    join(artifact_dir, "result.md"),
    [
      `# Session ${run_id}`,
      "",
      `- status: ${options.status}`,
      `- oracle_ok: ${options.oracle.ok}`,
      `- state: ${options.order.state}`,
      `- committed_purchase_count: ${options.order.committed_purchase_count}`,
      "",
    ].join("\n"),
  );

  return {
    run_id,
    status: options.status,
    order: options.order,
    oracle_ok: options.oracle.ok,
    oracle_reasons: options.oracle.reasons,
    metrics: options.metrics,
    artifact_dir,
  };
}

/** Deterministic path used to validate the runner before LLM agents. Not a baseline agent trial. */
export function runApparatusProxySession(options: {
  repoRoot: string;
  fixture: Fixture;
  experiment_id: string;
  repetition_index: number;
  specification?: unknown;
}): SessionResult {
  const store = new ReliableRailStore(options.fixture);
  const recorder = new EventRecorder();
  const { purchase, duplicate } = runScriptedHappyPath(store, recorder, "apparatus-proxy");
  const order = store.getOrder();
  const oracle = evaluateOrderOracle(options.fixture, order);
  const status: SessionResult["status"] = oracle.ok
    ? "included-success"
    : "included-task-failure";

  const spec: SessionSpec = {
    experiment_id: options.experiment_id,
    stage_id: "calibration",
    condition: "apparatus",
    agent_profile_version: "none-apparatus-proxy",
    prompt_version: "none-apparatus",
    environment_fixture_version: options.fixture.fixture_version,
    mechanism_flags: {
      contract_conformance: false,
      capability_freshness: false,
      structured_semantics: false,
      diagnosis_policy: false,
      effect_safety: false,
      state_recovery: false,
    },
    adversity_scenario_version: "none",
    repetition_index: options.repetition_index,
    runtime_lane: "native-requested",
  };

  return writeSessionArtifacts({
    repoRoot: options.repoRoot,
    spec,
    specification: options.specification ?? {},
    recorder,
    order,
    oracle,
    status,
    metrics: {
      task_success: oracle.ok,
      duplicate_effect_count:
        order.committed_purchase_count > 1 ? order.committed_purchase_count - 1 : 0,
      purchase_ok: purchase.ok,
      duplicate_rejected:
        duplicate.ok === false && duplicate.error === "duplicate_purchase_rejected",
      valid_action_rate: 1,
      invalid_call_rate: 0,
    },
    extra: {
      note: "apparatus-proxy: deterministic script validating session layout; not an LLM baseline trial",
    },
  });
}

export type DashboardIndexEntry = {
  experiment_id: string;
  run_id: string;
  condition: string;
  status: string;
  oracle_ok: boolean;
  artifact_dir: string;
  agent_profile_version: string;
};

export function rebuildDashboardIndex(repoRoot: string): DashboardIndexEntry[] {
  const experimentsRoot = join(repoRoot, "artifacts/experiments");
  const entries: DashboardIndexEntry[] = [];
  if (!existsSync(experimentsRoot)) return entries;

  for (const experiment_id of readdirSync(experimentsRoot)) {
    const expDir = join(experimentsRoot, experiment_id);
    if (!statSync(expDir).isDirectory()) continue;
    for (const condition of readdirSync(expDir)) {
      const condDir = join(expDir, condition);
      if (!statSync(condDir).isDirectory()) continue;
      for (const run_id of readdirSync(condDir)) {
        const runDir = join(condDir, run_id);
        if (!statSync(runDir).isDirectory()) continue;
        const finalPath = join(runDir, "final-state.json");
        const specPath = join(runDir, "specification.json");
        if (!existsSync(finalPath)) continue;
        const finalState = JSON.parse(readFileSync(finalPath, "utf8")) as {
          oracle?: { ok?: boolean };
          status?: string;
        };
        const spec = existsSync(specPath)
          ? (JSON.parse(readFileSync(specPath, "utf8")) as {
              agent_profile_version?: string;
            })
          : {};
        entries.push({
          experiment_id,
          run_id,
          condition,
          status: finalState.status ?? "unknown",
          oracle_ok: Boolean(finalState.oracle?.ok),
          artifact_dir: runDir,
          agent_profile_version: spec.agent_profile_version ?? "unknown",
        });
      }
    }
  }

  const indexPath = join(repoRoot, "artifacts/dashboard-index.json");
  writeFileSync(
    indexPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        session_count: entries.length,
        sessions: entries,
        note: "Read-only index for private research dashboard; not published",
      },
      null,
      2,
    ),
  );
  return entries;
}
