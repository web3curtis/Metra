import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
const baselineSpec = JSON.parse(
  readFileSync(
    join(root, "configurations/experiments/base-raw-webmcp-v0/specification.json"),
    "utf8",
  ),
);
const expASpec = JSON.parse(
  readFileSync(
    join(root, "configurations/experiments/exp-a-contract-v0/specification.json"),
    "utf8",
  ),
);
const task = JSON.parse(
  readFileSync(join(root, "configurations/tasks/task-v0.json"), "utf8"),
) as { constraints: { outbound_local: string; return_local: string } };

describe("exp-a vs baseline comparison batch", () => {
  it("runs 5 intervention sessions with contract on and writes COMPARISON.md", () => {
    const intervention = Array.from({ length: 5 }, (_, i) =>
      runReferenceToolPolicySession({
        repoRoot: root,
        fixture,
        experiment_id: "exp-a-contract-v0",
        repetition_index: i + 1,
        specification: expASpec,
        taskOutboundLocal: task.constraints.outbound_local,
        taskReturnLocal: task.constraints.return_local,
        contractConformance: true,
        condition: "intervention",
        stage_id: "exp-a",
      }),
    );

    expect(intervention.every((r) => r.oracle_ok)).toBe(true);
    expect(intervention.every((r) => r.artifact_dir.includes("/intervention/"))).toBe(true);

    // Adjacent baseline characterization already exists; reaffirm one baseline control run
    const baselineControl = runReferenceToolPolicySession({
      repoRoot: root,
      fixture,
      experiment_id: "base-raw-webmcp-v0",
      repetition_index: 99,
      specification: baselineSpec,
      taskOutboundLocal: task.constraints.outbound_local,
      taskReturnLocal: task.constraints.return_local,
      contractConformance: false,
      condition: "baseline",
    });
    expect(baselineControl.oracle_ok).toBe(true);

    const outDir = join(root, "artifacts/experiments/exp-a-contract-v0");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, "COMPARISON.md"),
      [
        "# COMPARISON — exp-a-contract-v0 vs baseline",
        "",
        "## Question",
        "Does Contract v0 enforcement improve valid-action / repeatable outcomes vs raw baseline?",
        "",
        "## Setup",
        "- IV: `contract_conformance` true vs false",
        "- Agent: tool-policy-v0 (not LLM)",
        "- n=5 intervention sessions this batch; baseline uses prior base-raw batch + 1 control",
        "",
        "## Results",
        `| Condition | n success | notes |`,
        `|---|---:|---|`,
        `| baseline (prior + control) | ≥5 + 1 | mechanisms off |`,
        `| A intervention | ${intervention.filter((r) => r.oracle_ok).length}/5 | contract on; happy path still succeeds |`,
        "",
        "## Interpretation",
        "Happy-path success rates match (both succeed). Contract value appears on **invalid early purchase** (unit-tested: `contract_violation` vs store precondition error), not on already-valid tool-policy runs.",
        "",
        "## Verdict",
        "**Mixed / incomplete for primary rates on happy path alone** — no material happy-path gain expected; diagnostic/precondition rejection semantics improved (supported for invalid-call classification). Full adversity (contract ambiguity) not yet run.",
        "",
        "## Next",
        "Yellow Manager consultancy for Experiment B, or Green adversity-ambiguity trial for A.",
        "",
        "## User Focus",
        "None Red.",
        "",
      ].join("\n"),
    );
  });
});
