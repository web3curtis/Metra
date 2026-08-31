import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALL_MECHANISMS_ON,
  runIntegratedToolPolicySession,
} from "../src/harness/integratedSession.ts";
import type { Fixture } from "../src/domain/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const fixture = JSON.parse(
  readFileSync(join(repoRoot, "configurations/fixtures/fixture-v0.json"), "utf8"),
) as Fixture;
const taskOutbound = fixture.task_target.outbound_depart_local.slice(0, 16);
const taskReturn = fixture.task_target.return_depart_local.slice(0, 16);

describe("Stage 9 integrated challenge", () => {
  it("passes ten consecutive integrated suites with all mechanisms on", () => {
    const results = [];
    for (let i = 0; i < 10; i += 1) {
      const r = runIntegratedToolPolicySession({
        repoRoot,
        fixture,
        experiment_id: "stage9-integrated-ten",
        repetition_index: i,
        specification: { stage: 9 },
        taskOutboundLocal: taskOutbound,
        taskReturnLocal: taskReturn,
        mechanisms: ALL_MECHANISMS_ON,
        condition: "intervention",
        stage_id: "stage9",
      });
      results.push({
        rep: i,
        oracle_ok: r.oracle_ok,
        commits: r.order.committed_purchase_count,
        status: r.status,
      });
      expect(r.oracle_ok).toBe(true);
      expect(r.order.committed_purchase_count).toBe(1);
    }
    const outDir = join(repoRoot, "artifacts/tonight/p2026.08.31.0/stage9-integrated");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "TEN_RUN.json"), `${JSON.stringify({ results, pass: true }, null, 2)}\n`);
  });

  it("passes mixed adversity timeout cell with mechanisms on", () => {
    const r = runIntegratedToolPolicySession({
      repoRoot,
      fixture,
      experiment_id: "stage9-timeout-mixed",
      repetition_index: 0,
      specification: { stage: 9, adversity: "client_timeout_after_commit" },
      taskOutboundLocal: taskOutbound,
      taskReturnLocal: taskReturn,
      mechanisms: ALL_MECHANISMS_ON,
      condition: "intervention",
      stage_id: "stage9",
      adversity: "client_timeout_after_commit",
    });
    expect(r.order.committed_purchase_count).toBe(1);
    expect(r.oracle_ok).toBe(true);
  });
});
