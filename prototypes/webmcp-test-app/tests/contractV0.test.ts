import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  validateCall,
  validateOutput,
} from "../../reliability-boundary/contract/contractV0.ts";
import { EventRecorder, invokeTool } from "../src/domain/harness.ts";
import { ReliableRailStore } from "../src/domain/store.ts";
import type { Fixture } from "../src/domain/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "../../../configurations/fixtures/fixture-v0.json"), "utf8"),
) as Fixture;

describe("Contract v0", () => {
  it("rejects purchase before ORDER_REVIEWED", () => {
    const result = validateCall({
      tool: "purchase_tickets",
      args: {},
      state: "SEATS_RESERVED",
    });
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.code).toBe("precondition_state");
  });

  it("allows purchase in ORDER_REVIEWED", () => {
    const result = validateCall({
      tool: "purchase_tickets",
      args: {},
      state: "ORDER_REVIEWED",
      currency: "AUD",
    });
    expect(result.ok).toBe(true);
  });

  it("validates purchase output shape", () => {
    expect(
      validateOutput({
        tool: "purchase_tickets",
        ok: true,
        data: { order_id: "1", receipt_id: "2", currency: "AUD" },
      }).ok,
    ).toBe(true);
    expect(
      validateOutput({
        tool: "purchase_tickets",
        ok: true,
        data: { currency: "AUD" },
      }).ok,
    ).toBe(false);
  });

  it("invokeTool middleware blocks early purchase when contract on", () => {
    const store = new ReliableRailStore(fixture);
    const recorder = new EventRecorder();
    const blocked = invokeTool(store, recorder, "purchase_tickets", {}, "exp-a", {
      contractConformance: true,
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toBe("contract_violation");
    const raw = invokeTool(store, recorder, "purchase_tickets", {}, "baseline", {
      contractConformance: false,
    });
    expect(raw.error).toBe("purchase_preconditions_unmet");
  });
});

describe("exp-a spec freeze file", () => {
  it("exists with contract flag as IV", () => {
    const spec = JSON.parse(
      readFileSync(
        join(here, "../../../configurations/experiments/exp-a-contract-v0/specification.json"),
        "utf8",
      ),
    );
    expect(spec.mechanism_flags.contract_conformance).toBe(true);
    expect(spec.experiment_id).toBe("exp-a-contract-v0");
  });
});
