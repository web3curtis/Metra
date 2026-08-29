import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALL_MECHANISMS_OFF,
  ALL_MECHANISMS_ON,
  runIntegratedToolPolicySession,
} from "../src/harness/integratedSession.ts";
import { rebuildDashboardIndex } from "../src/harness/sessionRunner.ts";
import type { Fixture } from "../src/domain/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const fixture = JSON.parse(
  readFileSync(join(repoRoot, "configurations/fixtures/fixture-v0.json"), "utf8"),
) as Fixture;

const taskOutbound = fixture.task_target.outbound_depart_local.slice(0, 16);
const taskReturn = fixture.task_target.return_depart_local.slice(0, 16);

describe("integrated A–D2 regression", () => {
  it("baseline (all off) completes exactly once", () => {
    const result = runIntegratedToolPolicySession({
      repoRoot,
      fixture,
      experiment_id: "reg-integrated-baseline-v0",
      repetition_index: 1,
      specification: { mechanisms: "off" },
      taskOutboundLocal: taskOutbound,
      taskReturnLocal: taskReturn,
      mechanisms: ALL_MECHANISMS_OFF,
      condition: "baseline",
      stage_id: "integration",
    });
    expect(result.oracle_ok).toBe(true);
    expect(result.order.committed_purchase_count).toBe(1);
    expect(result.metrics.duplicate_effect_count).toBe(0);
  });

  it("full stack (all on) completes exactly once", () => {
    const result = runIntegratedToolPolicySession({
      repoRoot,
      fixture,
      experiment_id: "reg-integrated-fullstack-v0",
      repetition_index: 1,
      specification: { mechanisms: "all" },
      taskOutboundLocal: taskOutbound,
      taskReturnLocal: taskReturn,
      mechanisms: ALL_MECHANISMS_ON,
      condition: "intervention",
      stage_id: "integration",
      adversity: "none",
    });
    expect(result.oracle_ok).toBe(true);
    expect(result.order.committed_purchase_count).toBe(1);
    expect(result.metrics.duplicate_rejected).toBe(true);
  });

  it("timeout-after-commit adversity keeps ≤1 purchase", () => {
    const result = runIntegratedToolPolicySession({
      repoRoot,
      fixture,
      experiment_id: "reg-integrated-timeout-v0",
      repetition_index: 1,
      specification: { adversity: "client_timeout_after_commit" },
      taskOutboundLocal: taskOutbound,
      taskReturnLocal: taskReturn,
      mechanisms: ALL_MECHANISMS_ON,
      condition: "intervention",
      stage_id: "integration",
      adversity: "client_timeout_after_commit",
    });
    expect(result.order.committed_purchase_count).toBe(1);
    expect(result.metrics.duplicate_effect_count).toBe(0);
    expect(result.oracle_ok).toBe(true);
  });

  it("generalization: alternate seat preference still succeeds with same mechanisms", () => {
    const control = runIntegratedToolPolicySession({
      repoRoot,
      fixture,
      experiment_id: "exp-gen-profiles-v0",
      repetition_index: 1,
      specification: { profile: "reference" },
      taskOutboundLocal: taskOutbound,
      taskReturnLocal: taskReturn,
      mechanisms: ALL_MECHANISMS_ON,
      agent_profile_version: "agent.reference-planner.v0",
      condition: "intervention",
      stage_id: "generalization",
      preferAlternateSeats: false,
    });
    const alternate = runIntegratedToolPolicySession({
      repoRoot,
      fixture,
      experiment_id: "exp-gen-profiles-v0",
      repetition_index: 2,
      specification: { profile: "codex-policy-standin" },
      taskOutboundLocal: taskOutbound,
      taskReturnLocal: taskReturn,
      mechanisms: ALL_MECHANISMS_ON,
      agent_profile_version: "agent.codex-planner.v0",
      condition: "intervention",
      stage_id: "generalization",
      preferAlternateSeats: true,
    });
    expect(control.oracle_ok).toBe(true);
    expect(alternate.oracle_ok).toBe(true);
    expect(control.order.seat_ids).not.toEqual(alternate.order.seat_ids);
    rebuildDashboardIndex(repoRoot);
  });
});
