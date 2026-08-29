import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Fixture } from "../src/domain/types.ts";
import { runReferenceToolPolicySession } from "../src/harness/referenceToolPolicy.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const fixture = JSON.parse(
  readFileSync(join(root, "configurations/fixtures/fixture-v0.json"), "utf8"),
) as Fixture;
const specification = JSON.parse(
  readFileSync(
    join(root, "configurations/experiments/base-raw-webmcp-v0/specification.json"),
    "utf8",
  ),
);
const task = JSON.parse(
  readFileSync(join(root, "configurations/tasks/task-v0.json"), "utf8"),
) as { constraints: { outbound_local: string; return_local: string } };

describe("reference tool-policy agent", () => {
  it("dry-run: discovers journeys/seats via tools and reaches oracle success", () => {
    const result = runReferenceToolPolicySession({
      repoRoot: root,
      fixture,
      experiment_id: "base-raw-webmcp-v0",
      repetition_index: 0,
      specification,
      taskOutboundLocal: task.constraints.outbound_local,
      taskReturnLocal: task.constraints.return_local,
    });
    expect(result.oracle_ok).toBe(true);
    expect(result.status).toBe("included-success");
    expect(result.artifact_dir).toContain("/baseline/");
  });

  it("batch: five baseline sessions all succeed under tool-policy-v0", () => {
    const results = Array.from({ length: 5 }, (_, i) =>
      runReferenceToolPolicySession({
        repoRoot: root,
        fixture,
        experiment_id: "base-raw-webmcp-v0",
        repetition_index: i + 1,
        specification,
        taskOutboundLocal: task.constraints.outbound_local,
        taskReturnLocal: task.constraints.return_local,
      }),
    );
    expect(results.every((r) => r.oracle_ok)).toBe(true);
    expect(results.every((r) => r.status === "included-success")).toBe(true);
  });
});
