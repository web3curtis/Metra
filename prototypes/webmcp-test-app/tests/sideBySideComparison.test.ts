import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Fixture } from "../src/domain/types.ts";
import { runSideBySideComparison } from "../src/harness/sideBySideComparison.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "../../../configurations/fixtures/fixture-v0.json"), "utf8"),
) as Fixture;

describe("side-by-side raw vs prototype", () => {
  it("happy path is equal and valid", () => {
    const r = runSideBySideComparison({ fixture, adversity: "none" });
    expect(r.comparison_valid).toBe(true);
    expect(r.improvement).toBe("equal");
    expect(r.raw.committed_purchase_count).toBe(1);
    expect(r.prototype.committed_purchase_count).toBe(1);
  });

  it("contract ambiguity: both safe; prototype has better diagnosis", () => {
    const r = runSideBySideComparison({ fixture, adversity: "contract_ambiguity" });
    expect(r.comparison_valid).toBe(true);
    expect(r.raw.committed_purchase_count).toBe(0);
    expect(r.prototype.committed_purchase_count).toBe(0);
    expect(r.improvement).toBe("prototype_better");
  });

  it("timeout: prototype reconciles with ≤1 commit", () => {
    const r = runSideBySideComparison({
      fixture,
      adversity: "client_timeout_after_commit",
    });
    expect(r.comparison_valid).toBe(true);
    expect(r.prototype.committed_purchase_count).toBe(1);
    expect(r.prototype.trace.some((t) => t.note === "reconcile")).toBe(true);
  });

  it("reload: prototype enforces stop", () => {
    const r = runSideBySideComparison({
      fixture,
      adversity: "reload_after_purchase",
    });
    expect(r.comparison_valid).toBe(true);
    expect(r.prototype.recovery_action).toBe("stop");
    expect(r.prototype.committed_purchase_count).toBe(1);
    expect(r.improvement).toBe("prototype_better");
  });
});
