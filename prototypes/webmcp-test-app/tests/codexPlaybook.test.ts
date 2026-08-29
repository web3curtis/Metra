import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCodexPlaybookSession } from "../src/harness/codexPlaybookSession.ts";
import type { Fixture } from "../src/domain/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const fixture = JSON.parse(
  readFileSync(join(repoRoot, "configurations/fixtures/fixture-v0.json"), "utf8"),
) as Fixture;
const taskOutbound = fixture.task_target.outbound_depart_local.slice(0, 16);
const taskReturn = fixture.task_target.return_depart_local.slice(0, 16);

describe("Critiqor playbook → Codex agent (before/after)", () => {
  it("stale epoch: playbook recovers via reobserve; naive path does not", () => {
    const before = runCodexPlaybookSession({
      repoRoot,
      fixture,
      experiment_id: "playbook-compare-stale-before",
      repetition_index: 1,
      specification: { playbook: false },
      taskOutboundLocal: taskOutbound,
      taskReturnLocal: taskReturn,
      adversity: "stale_epoch_then_refresh",
      playbookEnabled: false,
    });
    const after = runCodexPlaybookSession({
      repoRoot,
      fixture,
      experiment_id: "playbook-compare-stale-after",
      repetition_index: 1,
      specification: { playbook: true },
      taskOutboundLocal: taskOutbound,
      taskReturnLocal: taskReturn,
      adversity: "stale_epoch_then_refresh",
      playbookEnabled: true,
    });

    expect(before.oracle_ok).toBe(false);
    expect(before.playbook.blind_retry_attempted).toBe(true);
    expect(before.order.committed_purchase_count).toBe(0);

    expect(after.playbook.recovered).toBe(true);
    expect(after.oracle_ok).toBe(true);
    expect(after.order.committed_purchase_count).toBe(1);
    expect(after.playbook.blind_retry_attempted).toBe(false);

    const outDir = join(repoRoot, "artifacts/experiments/playbook-iteration-v1");
    mkdirSync(outDir, { recursive: true });
    const comparison = {
      generated_at: new Date().toISOString(),
      critiqor_source_run: "run_001",
      playbook_recommendation:
        "Inspect highest-impact runtime error; never blind-retry; reobserve then continue",
      before: {
        oracle_ok: before.oracle_ok,
        purchases: before.order.committed_purchase_count,
        blind_retry: before.playbook.blind_retry_attempted,
        recovered: before.playbook.recovered,
      },
      after: {
        oracle_ok: after.oracle_ok,
        purchases: after.order.committed_purchase_count,
        blind_retry: after.playbook.blind_retry_attempted,
        recovered: after.playbook.recovered,
      },
      improved:
        after.oracle_ok === true &&
        before.oracle_ok === false &&
        after.playbook.blind_retry_attempted === false,
    };
    writeFileSync(join(outDir, "COMPARISON.json"), JSON.stringify(comparison, null, 2));
    writeFileSync(
      join(outDir, "COMPARISON.md"),
      [
        "# COMPARISON — Critiqor playbook applied to Codex agent",
        "",
        "## Playbook source",
        "Critiqor `run_001`: inspect highest-impact runtime error; do not blind-retry; follow reobserve/reconcile/stop.",
        "",
        "## Stale-epoch adversity",
        `| | Before (no playbook) | After (playbook) |`,
        `|---|---|---|`,
        `| oracle_ok | ${before.oracle_ok} | ${after.oracle_ok} |`,
        `| purchases | ${before.order.committed_purchase_count} | ${after.order.committed_purchase_count} |`,
        `| blind_retry | ${before.playbook.blind_retry_attempted} | ${after.playbook.blind_retry_attempted} |`,
        `| recovered | ${before.playbook.recovered} | ${after.playbook.recovered} |`,
        "",
        `## Verdict`,
        comparison.improved
          ? "**Improved** — playbook reobserve recovered a successful single purchase; naive path failed with blind retry."
          : "**Not improved** — investigate.",
        "",
      ].join("\n"),
    );
    expect(comparison.improved).toBe(true);
  });

  it("timeout-after-commit: playbook keeps ≤1 purchase", () => {
    const after = runCodexPlaybookSession({
      repoRoot,
      fixture,
      experiment_id: "playbook-timeout-after",
      repetition_index: 1,
      specification: { playbook: true },
      taskOutboundLocal: taskOutbound,
      taskReturnLocal: taskReturn,
      adversity: "client_timeout_after_commit",
      playbookEnabled: true,
    });
    expect(after.order.committed_purchase_count).toBe(1);
    expect(after.metrics.duplicate_effect_count).toBe(0);
  });
});
