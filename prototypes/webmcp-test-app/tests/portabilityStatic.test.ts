import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runContractOracles, runScenario } from "../../reliability-boundary/scenarios/scenarioRunner.ts";
import { DOCUFLOW_FIXTURE } from "../../reliability-boundary/scenarios/fixtures/docuflow.fixture.ts";
import { WORKBOARD_FIXTURE } from "../../reliability-boundary/scenarios/fixtures/workboard.fixture.ts";

const here = dirname(fileURLToPath(import.meta.url));
const boundaryRoot = join(here, "../../reliability-boundary");

const FORBIDDEN_IMPORT_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "webmcp-test-app import/path", pattern: /webmcp-test-app/ },
  { label: "ReliableRailStore import", pattern: /ReliableRailStore/ },
];

/** purchase_tickets branching must not appear in the plugin surface re-export file. */
const PLUGIN_API_FORBIDDEN = {
  label: "purchase_tickets branching in plugin/api.ts",
  pattern: /purchase_tickets/,
};

function collectTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectTsFiles(full, acc);
    } else if (entry.endsWith(".ts")) {
      acc.push(full);
    }
  }
  return acc;
}

function relativeBoundaryPath(absPath: string): string {
  return absPath.slice(boundaryRoot.length + 1);
}

function scanFile(absPath: string): string[] {
  const text = readFileSync(absPath, "utf8");
  const rel = relativeBoundaryPath(absPath);
  const violations: string[] = [];

  for (const rule of FORBIDDEN_IMPORT_PATTERNS) {
    if (rule.pattern.test(text)) {
      violations.push(`${rel}: ${rule.label}`);
    }
  }

  if (rel === "plugin/api.ts" && PLUGIN_API_FORBIDDEN.pattern.test(text)) {
    violations.push(`${rel}: ${PLUGIN_API_FORBIDDEN.label}`);
  }

  return violations;
}

describe("portability static check (P0 substrate)", () => {
  it("core reliability-boundary .ts files do not import ReliableRail app paths", () => {
    const coreDirs = [
      "contract",
      "freshness",
      "semantics",
      "diagnosis",
      "effect",
      "recovery",
      "plugin",
      "scenarios",
    ];

    const files: string[] = [];
    for (const dir of coreDirs) {
      collectTsFiles(join(boundaryRoot, dir), files);
    }

    expect(files.length).toBeGreaterThan(0);

    const allViolations = files.flatMap((f) => scanFile(f));
    expect(allViolations, allViolations.join("\n")).toEqual([]);
  });

  it("plugin/api.ts exports only re-exports (no domain branching)", () => {
    const apiPath = join(boundaryRoot, "plugin/api.ts");
    const text = readFileSync(apiPath, "utf8");
    expect(text).not.toMatch(PLUGIN_API_FORBIDDEN.pattern);
    expect(text).toContain('from "../contract/contractV0.ts"');
    expect(text).toContain("PLUGIN_INVOKE_ORDER");
  });
});

describe("scenario runner smoke (plugin API only)", () => {
  it("runs WorkBoard oracle hooks in full-stack mode", () => {
    const results = runContractOracles(WORKBOARD_FIXTURE);
    expect(results.length).toBe(WORKBOARD_FIXTURE.oracleHooks.length);
    for (const r of results) {
      expect(r.scenarioId).toBe("workboard-v0");
      expect(r.mode).toBe("full-stack");
      expect(r.steps.length).toBeGreaterThan(0);
    }
  });

  it("off mode skips mechanisms", () => {
    const result = runScenario({
      contract: DOCUFLOW_FIXTURE,
      adversityKey: "wrong_precondition_state",
      mode: "off",
    });
    expect(result.blocked).toBe(false);
    expect(result.steps[0]?.mechanism).toBe("passthrough");
  });
});
