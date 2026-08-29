import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Fixture } from "../src/domain/types.ts";
import { runIntegratedMechanismSession } from "../src/harness/integratedMechanismSession.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const fixture = JSON.parse(
  readFileSync(join(repoRoot, "configurations/fixtures/fixture-v0.json"), "utf8"),
) as Fixture;

describe("integrated A-D2 session", () => {
  it("completes purchase with all mechanisms on", () => {
    const result = runIntegratedMechanismSession({
      repoRoot,
      fixture,
      experiment_id: "exp-integrated-a-d2-v0",
      repetition_index: 0,
      specification: { experiment_id: "exp-integrated-a-d2-v0" },
      taskOutboundLocal: fixture.task_target.outbound_depart_local.slice(0, 16),
      taskReturnLocal: fixture.task_target.return_depart_local.slice(0, 16),
      simulateReloadBeforePurchase: true,
    });
    expect(result.oracle_ok).toBe(true);
    expect(result.order.committed_purchase_count).toBe(1);
    expect(result.metrics.duplicate_effect_count).toBe(0);
  });
});
