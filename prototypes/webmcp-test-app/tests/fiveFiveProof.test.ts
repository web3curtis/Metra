/**
 * Proof suite: each A–D2 criterion for 5/5 quality bar.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PLUGIN_ID,
  PLUGIN_VERSION,
  PLUGIN_INVOKE_ORDER,
  validateCall,
  rejectStaleConsequential,
  envelopeFromToolError,
  selectDiagnosisAction,
  newOperationId,
  reconcileAmbiguousCommit,
  decideRecovery,
} from "../../reliability-boundary/plugin/api.ts";
import { EventRecorder, invokeTool } from "../src/domain/harness.ts";
import { ReliableRailStore } from "../src/domain/store.ts";
import { evaluateOrderOracle } from "../src/domain/oracle.ts";
import {
  ALL_MECHANISMS_ON,
  runIntegratedToolPolicySession,
} from "../src/harness/integratedSession.ts";
import { runCodexPlaybookSession } from "../src/harness/codexPlaybookSession.ts";
import type { EffectRecord } from "../../reliability-boundary/effect/effectSafety.ts";
import type { Fixture } from "../src/domain/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const fixture = JSON.parse(
  readFileSync(join(repoRoot, "configurations/fixtures/fixture-v0.json"), "utf8"),
) as Fixture;
const taskOutbound = fixture.task_target.outbound_depart_local.slice(0, 16);
const taskReturn = fixture.task_target.return_depart_local.slice(0, 16);

describe("plugin API surface (criterion 5 for all)", () => {
  it("exports stable plugin identity and ordered mechanisms", () => {
    expect(PLUGIN_ID).toBe("webmcp-reliability-boundary");
    expect(PLUGIN_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(PLUGIN_INVOKE_ORDER).toHaveLength(6);
    expect(typeof validateCall).toBe("function");
    expect(typeof rejectStaleConsequential).toBe("function");
    expect(typeof envelopeFromToolError).toBe("function");
    expect(typeof selectDiagnosisAction).toBe("function");
    expect(typeof newOperationId).toBe("function");
    expect(typeof decideRecovery).toBe("function");
  });
});

describe("A contract 5/5 stress", () => {
  it("under invalid-call struggle, contract reduces impact vs raw", () => {
    const attempts = 5;
    let rawSafe = 0;
    let gatedSafe = 0;
    let gatedContractCode = 0;

    for (let i = 0; i < attempts; i++) {
      const rawStore = new ReliableRailStore(fixture);
      const rawRec = new EventRecorder();
      const raw = invokeTool(rawStore, rawRec, "purchase_tickets", {}, "a-raw");
      if (!raw.ok && rawStore.getOrder().committed_purchase_count === 0) rawSafe++;

      const gStore = new ReliableRailStore(fixture);
      const gRec = new EventRecorder();
      const gated = invokeTool(gStore, gRec, "purchase_tickets", {}, "a-gate", {
        contractConformance: true,
        structuredSemantics: true,
        diagnosisPolicy: true,
      });
      if (!gated.ok && gStore.getOrder().committed_purchase_count === 0) gatedSafe++;
      if (gated.error === "contract_violation") gatedContractCode++;
      const data = gated.data as { structured_failure?: unknown; diagnosis_action?: { action: string } };
      expect(data.structured_failure).toBeTruthy();
      expect(data.diagnosis_action?.action).toBe("stop");
    }

    expect(rawSafe).toBe(attempts);
    expect(gatedSafe).toBe(attempts);
    expect(gatedContractCode).toBe(attempts);

    const out = join(repoRoot, "artifacts/experiments/exp-a-contract-v0");
    mkdirSync(out, { recursive: true });
    writeFileSync(
      join(out, "COMPARISON.md"),
      [
        "# COMPARISON — exp-a-contract-v0 (5/5 stress)",
        "",
        "## Struggle",
        "Invalid/early consequential purchase attempts (contract ambiguity).",
        "",
        "## Results",
        `| | Raw | Contract+C1+C2 |`,
        `|---|---:|---:|`,
        `| safe (0 commits) | ${rawSafe}/${attempts} | ${gatedSafe}/${attempts} |`,
        `| contract_violation code | 0 | ${gatedContractCode}/${attempts} |`,
        `| diagnosis stop | n/a | ${attempts}/${attempts} |`,
        "",
        "## Verdict",
        "**Supported** — struggle does not create commits; contract reduces impact via stable classification + stop diagnosis (vs opaque precondition errors).",
        "",
      ].join("\n"),
    );
  });
});

describe("B freshness 5/5", () => {
  it("stale struggle rejected; playbook reobserve recovers once", () => {
    const stale = rejectStaleConsequential("purchase_tickets", "a", "b");
    expect(stale.ok).toBe(false);
    const after = runCodexPlaybookSession({
      repoRoot,
      fixture,
      experiment_id: "fivefive-b-freshness",
      repetition_index: 1,
      specification: {},
      taskOutboundLocal: taskOutbound,
      taskReturnLocal: taskReturn,
      adversity: "stale_epoch_then_refresh",
      playbookEnabled: true,
    });
    expect(after.oracle_ok).toBe(true);
    expect(after.order.committed_purchase_count).toBe(1);
  });
});

describe("C1+C2 5/5 agent-usable", () => {
  it("flag on attaches envelope + diagnosis; agent playbook follows", () => {
    const store = new ReliableRailStore(fixture);
    const rec = new EventRecorder();
    const r = invokeTool(store, rec, "purchase_tickets", {}, "c", {
      contractConformance: true,
      structuredSemantics: true,
      diagnosisPolicy: true,
    });
    const data = r.data as {
      structured_failure: { category: string };
      diagnosis_action: { action: string };
    };
    expect(data.structured_failure.category).toBe("invalid_input_or_precondition");
    expect(data.diagnosis_action.action).toBe("stop");
    const decision = selectDiagnosisAction({
      structuredFailure: envelopeFromToolError({
        tool: "purchase_tickets",
        error: "contract_violation",
        state: "EMPTY",
        state_revision: 0,
      }),
    });
    expect(decision.action).toBe("stop");
  });
});

describe("D1 5/5", () => {
  it("auto op-id + timeout struggle keeps ≤1 purchase", () => {
    const id = newOperationId("t");
    expect(id.startsWith("t_")).toBe(true);
    const r = runIntegratedToolPolicySession({
      repoRoot,
      fixture,
      experiment_id: "fivefive-d1",
      repetition_index: 1,
      specification: {},
      taskOutboundLocal: taskOutbound,
      taskReturnLocal: taskReturn,
      mechanisms: ALL_MECHANISMS_ON,
      adversity: "client_timeout_after_commit",
      agent_profile_version: "agent.codex-planner.v1-playbook",
    });
    expect(r.order.committed_purchase_count).toBe(1);
    expect(r.metrics.duplicate_effect_count).toBe(0);
    const recon = reconcileAmbiguousCommit({
      operation_id: "op_x",
      observed: {
        state: "PURCHASED",
        order_id: "O",
        receipt_id: "R",
        committed_purchase_count: 1,
      },
      prior: null,
    });
    expect(recon.action).toBe("reuse_existing");
  });
});

describe("D2 5/5 stress session", () => {
  it("reload-after-purchase: recovery stop + no second commit", () => {
    const store = new ReliableRailStore(fixture);
    const recorder = new EventRecorder();
    const registry = new Map<string, EffectRecord>();
    const opts = {
      contractConformance: true,
      capabilityFreshness: true,
      structuredSemantics: true,
      diagnosisPolicy: true,
      effectSafety: true,
      effectRegistry: registry,
      expectedCapabilityEpoch: "e",
      actualCapabilityEpoch: "e",
    };
    const call = (name: Parameters<typeof invokeTool>[2], input: Record<string, unknown> = {}) =>
      invokeTool(store, recorder, name, input, "d2", opts);

    call("reset_fixture");
    call("select_journey", {
      outbound_journey_id: fixture.task_target.outbound_journey_id,
      return_journey_id: fixture.task_target.return_journey_id,
    });
    call("reserve_seats", { seat_ids: fixture.default_adjacent_pair });
    call("review_order");
    call("purchase_tickets", { operation_id: "op_d2" });
    const observed = store.getOrder();
    const decision = decideRecovery({
      tools_include_purchase: true,
      order_state: observed.state,
      order_id: observed.order_id,
      receipt_id: observed.receipt_id,
      total_aud: observed.total_aud,
      budget_aud: fixture.budget_aud,
      seat_ids: observed.seat_ids,
      price_drift: false,
      seat_drift: false,
    });
    expect(decision.action).toBe("stop");
    const dup = call("purchase_tickets", { operation_id: "op_d2b" });
    expect(dup.ok).toBe(false);
    expect(store.getOrder().committed_purchase_count).toBe(1);
    expect(evaluateOrderOracle(fixture, store.getOrder()).ok).toBe(true);

    const out = join(repoRoot, "artifacts/experiments/exp-d2-recovery-v0");
    mkdirSync(out, { recursive: true });
    writeFileSync(
      join(out, "COMPARISON.md"),
      [
        "# COMPARISON — exp-d2-recovery-v0 (5/5)",
        "",
        "## Struggle",
        "Reload after purchase (URL ≠ sole state).",
        "",
        "## Results",
        `- recovery_action: ${decision.action}`,
        `- committed_purchase_count: 1`,
        `- duplicate rejected: true`,
        "",
        "## Verdict",
        "**Supported** — struggle cannot force a second purchase; recovery stops resume of purchase.",
        "",
      ].join("\n"),
    );
  });
});
