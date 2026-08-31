import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Fixture } from "../src/domain/types.ts";
import {
  STAGE1_VARIATION_MATRIX,
  runStage1RawBaseline,
} from "../src/harness/stage1RawBaseline.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const fixture = JSON.parse(
  readFileSync(join(repoRoot, "configurations/fixtures/fixture-v0.json"), "utf8"),
) as Fixture;

describe("Stage 1 raw WebMCP baseline", () => {
  it("declares ≥3 mechanically equivalent surfaces per struggle", () => {
    expect(STAGE1_VARIATION_MATRIX.length).toBeGreaterThanOrEqual(6);
    for (const row of STAGE1_VARIATION_MATRIX) {
      expect(row.surfaces.length).toBeGreaterThanOrEqual(3);
      const ids = new Set(row.surfaces.map((s) => s.surface_id));
      expect(ids.size).toBe(row.surfaces.length);
    }
  });

  it("measures raw-lane pain through page-registered mock path and seals evidence", () => {
    const { outDir, cells, gate } = runStage1RawBaseline({
      repoRoot,
      fixture,
      candidateVersion: "p2026.08.31.0",
      repetitions: 5,
    });

    expect(gate.variation_matrix_ge_3).toBe(true);
    expect(gate.registered_path_exercised).toBe(true);
    expect(gate.observed_constraint).toBe(true);
    expect(gate.observed_drift).toBe(true);
    expect(gate.observed_opaque).toBe(true);
    expect(gate.observed_ambiguous).toBe(true);
    expect(gate.observed_interruption).toBe(true);
    expect(gate.hypothesized_separated).toBe(true);

    const drift = cells.filter(
      (c) => c.surface_id === "rail.stale_epoch_purchase" && c.evidence_class === "observed",
    );
    expect(drift).toHaveLength(5);
    expect(drift.every((c) => c.metrics.purchase_ok === true)).toBe(true);
    expect(drift.every((c) => c.metrics.stale_block_count === 0)).toBe(true);

    const ambiguous = cells.filter(
      (c) => c.surface_id === "rail.timeout_after_commit" && c.evidence_class === "observed",
    );
    expect(ambiguous).toHaveLength(5);
    expect(ambiguous.every((c) => c.metrics.client_ok === false)).toBe(true);
    expect(ambiguous.every((c) => c.metrics.committed_purchase_count === 1)).toBe(true);

    expect(existsSync(join(outDir, "VARIATION_MATRIX.json"))).toBe(true);
    expect(existsSync(join(outDir, "CELLS_INDEX.json"))).toBe(true);
    expect(existsSync(join(outDir, "GATE1_MACHINE.json"))).toBe(true);
  });
});
