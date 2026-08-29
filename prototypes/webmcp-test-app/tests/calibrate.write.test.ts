import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EventRecorder, runScriptedHappyPath } from "../src/domain/harness.ts";
import { evaluateOrderOracle } from "../src/domain/oracle.ts";
import { ReliableRailStore } from "../src/domain/store.ts";
import type { Fixture } from "../src/domain/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const fixture = JSON.parse(
  readFileSync(join(root, "configurations/fixtures/fixture-v0.json"), "utf8"),
) as Fixture;

describe("calibrate apparatus writes artifacts", () => {
  it("runs three deterministic calibration sessions", () => {
    const outDir = join(root, "artifacts/experiments/cal-apparatus-v0/apparatus");
    mkdirSync(outDir, { recursive: true });
    const repeats = 3;
    const digests: string[] = [];

    for (let i = 0; i < repeats; i += 1) {
      const store = new ReliableRailStore(fixture);
      const recorder = new EventRecorder();
      const { purchase, duplicate } = runScriptedHappyPath(store, recorder);
      const order = store.getOrder();
      const oracle = evaluateOrderOracle(fixture, order);
      const runDir = join(outDir, `run-${String(i + 1).padStart(2, "0")}`);
      mkdirSync(runDir, { recursive: true });

      const finalState = {
        order,
        oracle,
        purchase_ok: purchase.ok,
        duplicate_rejected:
          duplicate.ok === false && duplicate.error === "duplicate_purchase_rejected",
      };

      const digest = JSON.stringify({
        state: order.state,
        outbound: order.outbound_journey_id,
        return: order.return_journey_id,
        seats: order.seat_ids,
        total: order.total_aud,
        committed: order.committed_purchase_count,
        oracle_ok: oracle.ok,
        oracle_reasons: oracle.reasons,
        duplicate_rejected: finalState.duplicate_rejected,
      });
      digests.push(digest);

      writeFileSync(join(runDir, "events.jsonl"), recorder.toJsonl());
      writeFileSync(join(runDir, "final-state.json"), JSON.stringify(finalState, null, 2));
      writeFileSync(
        join(runDir, "metrics.json"),
        JSON.stringify(
          {
            apparatus_reset_ok: true,
            oracle_scripted_success: oracle.ok,
            duplicate_commit_count:
              order.committed_purchase_count > 1 ? order.committed_purchase_count - 1 : 0,
          },
          null,
          2,
        ),
      );
    }

    const deterministic = digests.every((d) => d === digests[0]);
    writeFileSync(
      join(outDir, "CALIBRATION_RESULT.md"),
      [
        "# Calibration result",
        "",
        `- repeats: ${repeats}`,
        `- deterministic_oracle_fields: ${deterministic}`,
        `- digest: \`${digests[0]}\``,
        "",
      ].join("\n"),
    );

    expect(deterministic).toBe(true);
    expect(digests[0]).toContain('"oracle_ok":true');
  });
});
