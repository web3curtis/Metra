import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Fixture } from "../src/domain/types.ts";
import {
  rebuildDashboardIndex,
  runApparatusProxySession,
} from "../src/harness/sessionRunner.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const fixture = JSON.parse(
  readFileSync(join(root, "configurations/fixtures/fixture-v0.json"), "utf8"),
) as Fixture;
const specification = JSON.parse(
  readFileSync(
    join(root, "configurations/experiments/cal-apparatus-v0/specification.json"),
    "utf8",
  ),
);

describe("session runner", () => {
  it("writes a versioned session folder and rebuilds dashboard index", () => {
    const result = runApparatusProxySession({
      repoRoot: root,
      fixture,
      experiment_id: "cal-apparatus-v0",
      repetition_index: 0,
      specification,
    });
    expect(result.oracle_ok).toBe(true);
    expect(result.status).toBe("included-success");
    expect(result.artifact_dir).toContain("artifacts/experiments/cal-apparatus-v0/apparatus/");

    const index = rebuildDashboardIndex(root);
    expect(index.some((e) => e.run_id === result.run_id)).toBe(true);
  });
});
