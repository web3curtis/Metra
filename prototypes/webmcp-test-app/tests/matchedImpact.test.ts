import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Fixture } from "../src/domain/types.ts";
import { runMatchedImpactBatch } from "../src/harness/matchedImpact.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const fixture = JSON.parse(
  readFileSync(join(repoRoot, "configurations/fixtures/fixture-v0.json"), "utf8"),
) as Fixture;
const taskOutbound = fixture.task_target.outbound_depart_local.slice(0, 16);
const taskReturn = fixture.task_target.return_depart_local.slice(0, 16);

describe("matched impact batch", () => {
  it("runs 5 paired none-adversity sessions with valid comparison", () => {
    const result = runMatchedImpactBatch({
      repoRoot,
      fixture,
      taskOutboundLocal: taskOutbound,
      taskReturnLocal: taskReturn,
      adversity: "none",
      sessions_per_arm: 5,
    });
    expect(result.comparison_valid).toBe(true);
    expect(result.control).toHaveLength(5);
    expect(result.treatment).toHaveLength(5);
    expect(result.verdict).toBe("uncertain");
  });

  it("runs paired timeout adversity with matched receipts", () => {
    const result = runMatchedImpactBatch({
      repoRoot,
      fixture,
      taskOutboundLocal: taskOutbound,
      taskReturnLocal: taskReturn,
      adversity: "client_timeout_after_commit",
      sessions_per_arm: 5,
    });
    expect(result.comparison_valid).toBe(true);
    expect(result.control).toHaveLength(5);
    expect(result.treatment).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(result.control[i]!.adversity_receipt.adversity_id).toBe(
        result.treatment[i]!.adversity_receipt.adversity_id,
      );
    }
  });
});
