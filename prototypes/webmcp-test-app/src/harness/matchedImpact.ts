/**
 * Matched raw vs treatment impact runner (deterministic tool policy).
 * Minimum 5 paired sessions; identical adversity receipts required.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createAdversityReceipt,
  assertMatchedAdversity,
  exactStageFlags,
  type AdversityId,
} from "../adversity/adversityEngine.ts";
import {
  ALL_MECHANISMS_OFF,
  ALL_MECHANISMS_ON,
  runIntegratedToolPolicySession,
} from "./integratedSession.ts";
import type { Fixture } from "../domain/types.ts";

export type ImpactArmResult = {
  arm: "control" | "treatment";
  repetition_index: number;
  adversity_receipt: ReturnType<typeof createAdversityReceipt>;
  committed_purchase_count: number;
  task_success: boolean;
  first_purchase_reported_ok: boolean;
  total_tool_calls: number;
  session_id: string;
};

export function runMatchedImpactBatch(options: {
  repoRoot: string;
  fixture: Fixture;
  taskOutboundLocal: string;
  taskReturnLocal: string;
  adversity: AdversityId;
  sessions_per_arm?: number;
  outDir?: string;
}): {
  comparison_valid: boolean;
  invalid_reason?: string;
  control: ImpactArmResult[];
  treatment: ImpactArmResult[];
  verdict: "supported" | "rejected" | "mixed" | "uncertain" | "invalid";
} {
  const n = options.sessions_per_arm ?? 5;
  const control: ImpactArmResult[] = [];
  const treatment: ImpactArmResult[] = [];
  const seed = `impact-${options.adversity}`;

  for (let i = 0; i < n; i++) {
    const cReceipt = createAdversityReceipt({
      adversity_id: options.adversity,
      arm: "control",
      payload: { seed: `${seed}-r${i}` },
    });
    const tReceipt = createAdversityReceipt({
      adversity_id: options.adversity,
      arm: "treatment",
      payload: { seed: `${seed}-r${i}` },
    });
    const match = assertMatchedAdversity(cReceipt, tReceipt);
    if (!match.ok) {
      return {
        comparison_valid: false,
        invalid_reason: match.reason,
        control,
        treatment,
        verdict: "invalid",
      };
    }

    const adversityHarness =
      options.adversity === "client_timeout_after_commit"
        ? ("client_timeout_after_commit" as const)
        : options.adversity === "reload_after_purchase"
          ? ("reload_after_review" as const)
          : ("none" as const);

    const cSession = runIntegratedToolPolicySession({
      repoRoot: options.repoRoot,
      fixture: options.fixture,
      experiment_id: "impact-raw-v0",
      repetition_index: i,
      specification: { mechanisms: exactStageFlags("off"), adversity: cReceipt },
      taskOutboundLocal: options.taskOutboundLocal,
      taskReturnLocal: options.taskReturnLocal,
      mechanisms: ALL_MECHANISMS_OFF,
      condition: "baseline",
      stage_id: "impact-control",
      adversity: adversityHarness,
    });
    control.push({
      arm: "control",
      repetition_index: i,
      adversity_receipt: cReceipt,
      committed_purchase_count: Number(cSession.metrics.committed_purchase_count ?? 0),
      task_success: Boolean(cSession.metrics.task_success),
      first_purchase_reported_ok: Boolean(cSession.metrics.first_purchase_reported_ok),
      total_tool_calls: Number(cSession.metrics.total_tool_calls ?? 0),
      session_id: cSession.run_id,
    });

    const tSession = runIntegratedToolPolicySession({
      repoRoot: options.repoRoot,
      fixture: options.fixture,
      experiment_id: "impact-treatment-v0",
      repetition_index: i,
      specification: { mechanisms: ALL_MECHANISMS_ON, adversity: tReceipt },
      taskOutboundLocal: options.taskOutboundLocal,
      taskReturnLocal: options.taskReturnLocal,
      mechanisms: ALL_MECHANISMS_ON,
      condition: "intervention",
      stage_id: "impact-treatment",
      adversity: adversityHarness,
    });
    treatment.push({
      arm: "treatment",
      repetition_index: i,
      adversity_receipt: tReceipt,
      committed_purchase_count: Number(tSession.metrics.committed_purchase_count ?? 0),
      task_success: Boolean(tSession.metrics.task_success),
      first_purchase_reported_ok: Boolean(tSession.metrics.first_purchase_reported_ok),
      total_tool_calls: Number(tSession.metrics.total_tool_calls ?? 0),
      session_id: tSession.run_id,
    });
  }

  const cOk = control.filter((r) => r.task_success).length;
  const tOk = treatment.filter((r) => r.task_success).length;
  const cDup = control.filter((r) => r.committed_purchase_count > 1).length;
  const tDup = treatment.filter((r) => r.committed_purchase_count > 1).length;

  let verdict: "supported" | "rejected" | "mixed" | "uncertain" = "uncertain";
  if (options.adversity === "none" && cOk === n && tOk === n) {
    verdict = "uncertain"; // happy-path equality is not improvement
  } else if (tDup < cDup || (tOk >= cOk && tDup === 0 && cDup > 0)) {
    verdict = "supported";
  } else if (tOk < cOk && tDup >= cDup) {
    verdict = "rejected";
  } else if (tOk !== cOk || tDup !== cDup) {
    verdict = "mixed";
  }

  const outDir =
    options.outDir ??
    join(options.repoRoot, "artifacts/experiments/impact-matched-v0");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "COMPARISON.json"),
    JSON.stringify(
      {
        comparison_valid: true,
        adversity: options.adversity,
        sessions_per_arm: n,
        control_success: cOk,
        treatment_success: tOk,
        control_multi_commit: cDup,
        treatment_multi_commit: tDup,
        verdict,
        control,
        treatment,
      },
      null,
      2,
    ),
  );

  return { comparison_valid: true, control, treatment, verdict };
}
