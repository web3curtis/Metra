import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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
  readFileSync(join(repoRoot, "configurations/fixtures/fixture-ext-v0.json"), "utf8"),
) as Fixture;

describe("external validity (declared second fixture)", () => {
  it("full stack succeeds on Melbourne–Albury fixture", () => {
    const result = runIntegratedToolPolicySession({
      repoRoot,
      fixture,
      experiment_id: "exp-ext-validity-v0",
      repetition_index: 1,
      specification: {
        note: "Separate from ReliableRail Syd–Cbr causal claims",
        application: "ReliableRail Ext Sandbox (same code, different fixture)",
      },
      taskOutboundLocal: fixture.task_target.outbound_depart_local.slice(0, 16),
      taskReturnLocal: fixture.task_target.return_depart_local.slice(0, 16),
      mechanisms: ALL_MECHANISMS_ON,
      condition: "intervention",
      stage_id: "external-validity",
    });
    expect(result.oracle_ok).toBe(true);
    expect(result.order.committed_purchase_count).toBe(1);
    expect(result.order.total_aud).toBe(260);
  });
});
