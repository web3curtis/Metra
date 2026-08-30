import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Fixture } from "../src/domain/types.ts";
import { runFullAdversityBattery } from "../src/harness/fullAdversityBattery.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "../../../configurations/fixtures/fixture-v0.json"), "utf8"),
) as Fixture;

describe("full ReliableRail safety battery (all implementations)", () => {
  it("runs A–D2 cells with matched side-by-side comparisons", () => {
    const report = runFullAdversityBattery(fixture);
    expect(report.cells.length).toBeGreaterThanOrEqual(5);
    expect(report.cells.map((c) => c.impl).sort()).toEqual(
      ["A", "B", "C1", "C2", "D1", "D2"].sort(),
    );
    // Print failures for managers — assert each known cell policy
    const byImpl = Object.fromEntries(report.cells.map((c) => [c.impl, c]));
    expect(byImpl.A?.pass).toBe(true);
    expect(byImpl.B?.pass).toBe(true);
    expect(byImpl.C1?.pass).toBe(true);
    expect(byImpl.D1?.pass).toBe(true);
    expect(byImpl.D2?.pass).toBe(true);
    expect(byImpl.C2?.pass).toBe(true);
    expect(report.all_pass).toBe(true);
  });
});
