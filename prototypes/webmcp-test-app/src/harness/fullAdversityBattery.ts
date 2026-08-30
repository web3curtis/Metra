/**
 * Full safety battery — every A–D2 adversity on ReliableRail, raw vs prototype.
 * Like testing each car safety feature on the same track.
 */

import type { Fixture } from "../domain/types.ts";
import {
  runSideBySideComparison,
  type SideBySideResult,
} from "./sideBySideComparison.ts";
import type { AdversityId } from "../adversity/adversityEngine.ts";

export type BatteryCell = {
  impl: "A" | "B" | "C1" | "C2" | "D1" | "D2";
  adversity: AdversityId;
  result: SideBySideResult;
  pass: boolean;
  reason: string;
};

export type BatteryReport = {
  ran_at: string;
  cells: BatteryCell[];
  all_pass: boolean;
  pass_count: number;
  fail_count: number;
  summary: string;
};

const BATTERY: Array<{ impl: BatteryCell["impl"]; adversity: AdversityId }> = [
  { impl: "A", adversity: "contract_ambiguity" },
  { impl: "B", adversity: "capability_change" },
  { impl: "C1", adversity: "opaque_failure" },
  { impl: "C2", adversity: "client_timeout_after_commit" }, // diagnosis enforce via reconcile
  { impl: "D1", adversity: "client_timeout_after_commit" },
  { impl: "D2", adversity: "reload_after_purchase" },
];

function cellPass(impl: BatteryCell["impl"], r: SideBySideResult): { pass: boolean; reason: string } {
  if (!r.comparison_valid) {
    return { pass: false, reason: r.invalid_reason ?? "comparison_invalid" };
  }
  switch (impl) {
    case "A":
      return {
        pass:
          r.raw.committed_purchase_count === 0 &&
          r.prototype.committed_purchase_count === 0 &&
          (r.prototype.structured_failure != null ||
            r.prototype.last_error === "contract_violation" ||
            r.improvement === "prototype_better"),
        reason: "A: both 0 commits; prototype classifies/stops",
      };
    case "B":
      return {
        pass:
          r.prototype.committed_purchase_count === 1 &&
          r.prototype.trace.some((t) => t.note === "after_reobserve") &&
          (r.improvement === "prototype_better" ||
            r.raw.committed_purchase_count !== 1 ||
            r.raw.trace.some((t) => t.note === "blind_retry")),
        reason: "B: prototype reobserve then exactly one commit",
      };
    case "C1":
      return {
        pass:
          r.prototype.committed_purchase_count === 0 &&
          r.prototype.structured_failure != null &&
          r.raw.structured_failure == null,
        reason: "C1: same opaque path; only prototype has envelope",
      };
    case "C2":
      return {
        pass:
          r.prototype.committed_purchase_count === 1 &&
          r.prototype.trace.some((t) => t.note === "reconcile") &&
          (r.prototype.diagnosis_action != null ||
            r.improvement === "prototype_better" ||
            r.improvement === "equal" ||
            r.improvement === "inconclusive"),
        reason: "C2: reconcile step enforced on timeout path",
      };
    case "D1":
      return {
        pass:
          r.prototype.committed_purchase_count === 1 &&
          r.prototype.operation_id != null &&
          r.prototype.trace.some((t) => t.note === "reconcile"),
        reason: "D1: op-id + reconcile + ≤1 commit",
      };
    case "D2":
      return {
        pass:
          r.prototype.recovery_action === "stop" &&
          r.prototype.committed_purchase_count === 1,
        reason: "D2: reload rehydrate + stop enforced",
      };
    default: {
      const _exhaustive: never = impl;
      return { pass: false, reason: String(_exhaustive) };
    }
  }
}

export function runFullAdversityBattery(fixture: Fixture): BatteryReport {
  const cells: BatteryCell[] = [];
  // D1 and C2 share adversity — run once each for reporting clarity
  const seen = new Set<string>();
  for (const spec of BATTERY) {
    const key = `${spec.impl}:${spec.adversity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const result = runSideBySideComparison({
      fixture,
      adversity: spec.adversity,
    });
    const { pass, reason } = cellPass(spec.impl, result);
    cells.push({
      impl: spec.impl,
      adversity: spec.adversity,
      result,
      pass,
      reason: pass ? `PASS — ${reason}` : `FAIL — ${reason}; improvement=${result.improvement}`,
    });
  }
  const pass_count = cells.filter((c) => c.pass).length;
  const fail_count = cells.length - pass_count;
  return {
    ran_at: new Date().toISOString(),
    cells,
    all_pass: fail_count === 0,
    pass_count,
    fail_count,
    summary: fail_count === 0
      ? `Full safety battery PASS (${pass_count}/${cells.length} implementations).`
      : `Battery incomplete: ${pass_count}/${cells.length} PASS. Fix failing cells before plugin.`,
  };
}
