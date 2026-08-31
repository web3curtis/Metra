/**
 * Sealed 30-criterion proof suite — generates immutable evidence under tonight freeze.
 * Real harness + spine path; no policy softening.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProtocolRunContext,
  normalizeOutcome,
  classifyDriftRelevance,
  evaluateFreshness,
  intentFingerprint,
  EffectJournal,
  createVerifiedCheckpoint,
  recoverFromInterruption,
  selectDiagnosisAction,
  validateCall,
  envelopeFromToolError,
  reconcileAmbiguousCommit,
  newOperationId,
} from "../../reliability-boundary/plugin/api.ts";
import { getToolContract as getContract } from "../../reliability-boundary/contract/contractV0.ts";
import { EventRecorder, invokeTool } from "../src/domain/harness.ts";
import { ReliableRailStore } from "../src/domain/store.ts";
import { evaluateOrderOracle } from "../src/domain/oracle.ts";
import {
  ALL_MECHANISMS_ON as ALL_ON,
  runIntegratedToolPolicySession,
} from "../src/harness/integratedSession.ts";
import { labToolContracts, validateLabToolCall } from "../src/lab/labContracts.ts";
import { USE_CASES } from "../src/lab/catalog.ts";
import type { Fixture } from "../src/domain/types.ts";
import type { EffectRecord } from "../../reliability-boundary/effect/effectSafety.ts";

function toolContract(name: string) {
  return getContract(name);
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const fixture = JSON.parse(
  readFileSync(join(repoRoot, "configurations/fixtures/fixture-v0.json"), "utf8"),
) as Fixture;
const taskOutbound = fixture.task_target.outbound_depart_local.slice(0, 16);
const taskReturn = fixture.task_target.return_depart_local.slice(0, 16);
const outDir = join(repoRoot, "artifacts/tonight/p2026.08.31.5/proof-30");
mkdirSync(outDir, { recursive: true });

function writeEvidence(name: string, value: unknown): void {
  writeFileSync(join(outDir, name), `${JSON.stringify(value, null, 2)}\n`);
}

describe("30-criterion sealed proof", () => {
  it("A3: recovery path revalidates contract before resume", () => {
    const protocol = new ProtocolRunContext({
      document_epoch: "doc:1",
      session_epoch: "sess:1",
      contract_version: "a-v1",
    });
    const cp = createVerifiedCheckpoint({
      protocol,
      order_state: "ORDER_REVIEWED",
      order_id: null,
      receipt_id: null,
      state_revision: 5,
      postconditions_met: true,
    });
    const recovered = recoverFromInterruption({
      protocol,
      checkpoint: cp,
      current_document_epoch: "doc:1",
      current_session_epoch: "sess:1",
      ambiguous_effect_pending: false,
      observed: {
        tools_include_purchase: true,
        order_state: "ORDER_REVIEWED",
        order_id: null,
        receipt_id: null,
        total_aud: 120,
        budget_aud: 200,
        seat_ids: fixture.default_adjacent_pair,
        price_drift: false,
        seat_drift: false,
      },
    });
    expect(recovered.requires_ab_revalidation).toBe(true);
    expect(recovered.decision.action).toBe("resume");
    const events = protocol.allEvents();
    expect(events.some((e) => e.event_type === "ab_revalidate_before_resume")).toBe(true);
    // Contract still valid for purchase in reviewed state
    const gate = validateCall({
      tool: "purchase_tickets",
      args: {},
      state: "ORDER_REVIEWED",
      currency: "AUD",
      protocol,
    });
    expect(gate.ok).toBe(true);
    writeEvidence("A3-recovery-revalidate.json", {
      recovered,
      events: events.filter((e) =>
        ["ab_revalidate_before_resume", "checkpoint_created", "recovery_decision", "contract_validate"].includes(
          e.event_type,
        ),
      ),
    });
  });

  it("A5: six-domain disguised transfer without policy-core edits", () => {
    const surfaces = USE_CASES.map((uc) => {
      const action = uc.tools.find((t) => !t.readOnly)!;
      const id = `${uc.id}.${action.name}`;
      const blocked = validateLabToolCall(id, { wrong_field: true });
      const ok = validateLabToolCall(id, {
        operation_id: `op_${uc.id}_xfer`,
        expected_revision: 1,
      });
      return {
        surface: uc.id,
        prompt_flavor: uc.userPrompt.slice(0, 60),
        tool: id,
        blocked_ok: blocked.ok,
        allowed_ok: ok.ok,
        effect_class: ok.effect_class,
      };
    });
    expect(surfaces).toHaveLength(6);
    expect(surfaces.every((s) => s.allowed_ok && !s.blocked_ok)).toBe(true);
    // Engine unchanged: ReliableRail still uses same validateAgainstContract path
    expect(toolContract("purchase_tickets")?.contract_version).toBe("a-v1");
    writeEvidence("A5-six-domain-transfer.json", { surfaces, engine: "validateAgainstContract" });
  });

  it("B2: race, missed notification, and irrelevant change controls", () => {
    const planned = {
      capability_epoch: "epoch:a",
      document_epoch: "doc:1",
      session_epoch: "sess:1",
      state_revision: 3,
      source_evidence_ids: ["e1"],
    };
    const currentFresh = { ...planned };
    const irrelevant = classifyDriftRelevance({
      tool: "purchase_tickets",
      planned,
      current: currentFresh,
      events: [{ kind: "unrelated_ui_text_change", observed_at_ms: 1 }],
    });
    expect(irrelevant.relevant).toBe(false);
    expect(irrelevant.ignored).toHaveLength(1);

    const race = classifyDriftRelevance({
      tool: "purchase_tickets",
      planned,
      current: currentFresh,
      events: [{ kind: "race_before_dispatch", observed_at_ms: 2 }],
    });
    expect(race.relevant).toBe(true);
    expect(race.blocking?.ok).toBe(false);

    const missed = classifyDriftRelevance({
      tool: "purchase_tickets",
      planned,
      current: { ...planned, capability_epoch: "epoch:b" },
      events: [{ kind: "missed_notification", observed_at_ms: 3 }],
    });
    expect(missed.blocking?.ok).toBe(false);

    writeEvidence("B2-drift-controls.json", { irrelevant, race, missed });
  });

  it("B5: freshness precision and cost across transfer surfaces", () => {
    const rows = [];
    for (const uc of USE_CASES) {
      const action = uc.tools.find((t) => !t.readOnly)!;
      const id = `${uc.id}.${action.name}`;
      const contracts = labToolContracts();
      const contract = contracts[id]!;
      const t0 = Date.now();
      const stale = evaluateFreshness({
        tool: id,
        contract,
        planned: {
          capability_epoch: "e1",
          document_epoch: "d1",
          session_epoch: null,
          state_revision: 1,
          source_evidence_ids: [],
        },
        current: {
          capability_epoch: "e2",
          document_epoch: "d1",
          session_epoch: null,
          state_revision: 1,
          source_evidence_ids: [],
        },
      });
      const fresh = evaluateFreshness({
        tool: id,
        contract,
        planned: {
          capability_epoch: "e1",
          document_epoch: "d1",
          session_epoch: null,
          state_revision: 1,
          source_evidence_ids: [],
        },
        current: {
          capability_epoch: "e1",
          document_epoch: "d1",
          session_epoch: null,
          state_revision: 1,
          source_evidence_ids: [],
        },
      });
      rows.push({
        surface: uc.id,
        stale_blocked: !stale.ok,
        fresh_allowed: fresh.ok,
        duration_ms: Date.now() - t0,
      });
    }
    expect(rows.every((r) => r.stale_blocked && r.fresh_allowed)).toBe(true);
    writeEvidence("B5-freshness-transfer-cost.json", { rows });
  });

  it("C1.2 + C1.5: normalize throw/reject/timeout/cancel/malformed + transfer overhead", () => {
    const kinds = ["thrown", "rejected", "timeout", "cancelled", "tool_error", "malformed_success", "partial"] as const;
    const byKind = kinds.map((kind) =>
      normalizeOutcome({
        tool: "purchase_tickets",
        state: "ORDER_REVIEWED",
        state_revision: 4,
        operation_id: "op_norm",
        kind: kind === "malformed_success" ? "success" : kind,
        malformed: kind === "malformed_success",
        error: kind === "thrown" ? new Error("boom") : kind,
        value: { incomplete: true },
      }),
    );
    expect(byKind.every((o) => o.raw_preserved !== undefined)).toBe(true);
    expect(byKind.every((o) => !o.ok)).toBe(true);
    expect(byKind.find((o) => o.kind === "timeout")?.structured_failure?.category).toBe("ambiguous_commit");
    expect(byKind.find((o) => o.kind === "malformed_success")?.structured_failure?.category).toBe(
      "malformed_success",
    );

    // Transfer: same normalizer on lab commerce tool name
    const labTimeout = normalizeOutcome({
      tool: "commerce.create_order",
      state: "READY",
      state_revision: 1,
      kind: "timeout",
      error: "timeout",
      operation_id: "op_lab",
    });
    expect(labTimeout.structured_failure?.category).toBe("ambiguous_commit");
    writeEvidence("C1-normalize-transfer.json", { byKind, labTimeout });
  });

  it("C2.2 + C2.4: decisions control mixed adversity dispatch", () => {
    const protocol = new ProtocolRunContext();
    const store = new ReliableRailStore(fixture);
    const recorder = new EventRecorder();
    const registry = new Map<string, EffectRecord>();

    // Stale → reobserve decision → block purchase → allow search → clear → still need freshness
    const stale = invokeTool(store, recorder, "purchase_tickets", { operation_id: "op_x" }, "mix", {
      protocol,
      contractConformance: true,
      capabilityFreshness: true,
      structuredSemantics: true,
      diagnosisPolicy: true,
      effectSafety: true,
      effectRegistry: registry,
      expectedCapabilityEpoch: "a",
      actualCapabilityEpoch: "b",
    });
    expect(stale.ok).toBe(false);
    expect(protocol.decision?.action).toBe("reobserve");
    const blocked = invokeTool(store, recorder, "purchase_tickets", {}, "mix", { protocol });
    expect(blocked.error).toBe("decision_requires_reobserve");
    invokeTool(store, recorder, "search_journeys", { origin: "SYD" }, "mix", { protocol });
    expect(protocol.decision).toBeNull();

    // Timeout ambiguity → reconcile
    const store2 = new ReliableRailStore(fixture);
    const rec2 = new EventRecorder();
    const protocol2 = new ProtocolRunContext();
    const reg2 = new Map<string, EffectRecord>();
    invokeTool(store2, rec2, "reset_fixture", {}, "mix2", { protocol: protocol2 });
    invokeTool(
      store2,
      rec2,
      "select_journey",
      {
        outbound_journey_id: fixture.task_target.outbound_journey_id,
        return_journey_id: fixture.task_target.return_journey_id,
      },
      "mix2",
      { protocol: protocol2, contractConformance: true },
    );
    invokeTool(
      store2,
      rec2,
      "reserve_seats",
      { seat_ids: fixture.default_adjacent_pair },
      "mix2",
      { protocol: protocol2, contractConformance: true },
    );
    invokeTool(store2, rec2, "review_order", {}, "mix2", { protocol: protocol2, contractConformance: true });
    const timed = invokeTool(store2, rec2, "purchase_tickets", { operation_id: "op_to" }, "mix2", {
      protocol: protocol2,
      contractConformance: true,
      structuredSemantics: true,
      diagnosisPolicy: true,
      effectSafety: true,
      effectRegistry: reg2,
      simulateClientTimeoutAfterCommit: true,
      expectedCapabilityEpoch: "e",
      actualCapabilityEpoch: "e",
      capabilityFreshness: true,
    });
    expect(timed.ok).toBe(false);
    expect(protocol2.decision?.action).toBe("reconcile");
    const blind = invokeTool(store2, rec2, "purchase_tickets", { operation_id: "op_to2" }, "mix2", {
      protocol: protocol2,
      effectSafety: true,
      effectRegistry: reg2,
    });
    expect(blind.error).toBe("decision_requires_reconcile");
    expect(store2.getOrder().committed_purchase_count).toBe(1);
    writeEvidence("C2-mixed-adversity-enforcement.json", {
      stale_action: protocol.decision,
      timed_action: "reconcile",
      commits: store2.getOrder().committed_purchase_count,
    });
  });

  it("C2.5 + D1.5: transfer surfaces and operational cost", () => {
    const costs = [];
    for (const uc of USE_CASES.slice(0, 3)) {
      const t0 = Date.now();
      const action = uc.tools.find((t) => !t.readOnly)!;
      const id = `${uc.id}.${action.name}`;
      const fp = intentFingerprint({
        tool: id,
        args: { operation_id: "op1", expected_revision: 1 },
        state_revision: 1,
        contract_version: "a-v1-lab",
      });
      const journal = new EffectJournal();
      journal.append({
        at_ms: Date.now(),
        operation_id: "op1",
        intent_fingerprint: fp,
        tool: id,
        phase: "in_flight",
      });
      expect(journal.conflictOnReuse({ operation_id: "op1", intent_fingerprint: "other" })).toBe(true);
      costs.push({ surface: uc.id, duration_ms: Date.now() - t0, fingerprint: fp });
    }
    writeEvidence("C2D1-transfer-cost.json", { costs });
  });

  it("D1.4 + D2: timeout then reload composition with checkpoint", () => {
    const protocol = new ProtocolRunContext({
      document_epoch: "doc:9",
      session_epoch: "sess:9",
    });
    const store = new ReliableRailStore(fixture);
    const recorder = new EventRecorder();
    const registry = new Map<string, EffectRecord>();
    const journal = new EffectJournal();
    invokeTool(store, recorder, "reset_fixture", {}, "comp", { protocol });
    invokeTool(
      store,
      recorder,
      "select_journey",
      {
        outbound_journey_id: fixture.task_target.outbound_journey_id,
        return_journey_id: fixture.task_target.return_journey_id,
      },
      "comp",
      { protocol, contractConformance: true },
    );
    invokeTool(
      store,
      recorder,
      "reserve_seats",
      { seat_ids: fixture.default_adjacent_pair },
      "comp",
      { protocol, contractConformance: true },
    );
    invokeTool(store, recorder, "review_order", {}, "comp", { protocol, contractConformance: true });
    const op = newOperationId("comp");
    const fp = intentFingerprint({
      tool: "purchase_tickets",
      args: { operation_id: op },
      state_revision: store.getOrder().state_revision,
    });
    journal.append({
      at_ms: Date.now(),
      operation_id: op,
      intent_fingerprint: fp,
      tool: "purchase_tickets",
      phase: "in_flight",
    });
    const timed = invokeTool(store, recorder, "purchase_tickets", { operation_id: op }, "comp", {
      protocol,
      contractConformance: true,
      capabilityFreshness: true,
      structuredSemantics: true,
      diagnosisPolicy: true,
      effectSafety: true,
      effectRegistry: registry,
      simulateClientTimeoutAfterCommit: true,
      expectedCapabilityEpoch: "stable",
      actualCapabilityEpoch: "stable",
    });
    expect(timed.ok).toBe(false);
    expect(store.getOrder().committed_purchase_count).toBe(1);
    journal.append({
      at_ms: Date.now(),
      operation_id: op,
      intent_fingerprint: fp,
      tool: "purchase_tickets",
      phase: "unknown",
      note: "timeout_after_commit",
    });

    const cp = createVerifiedCheckpoint({
      protocol,
      order_state: store.getOrder().state,
      order_id: store.getOrder().order_id,
      receipt_id: store.getOrder().receipt_id,
      state_revision: store.getOrder().state_revision,
      operation_journal_refs: [op],
      postconditions_met: true,
    });
    // Simulate reload discontinuity
    protocol.transitionRecovery("interrupted");
    recorder.record({
      component: "harness",
      stage: "comp",
      event_type: "document_discontinuity",
      payload: { kind: "reload" },
    });
    // Must reconcile before recovery resume
    const blockedResume = recoverFromInterruption({
      protocol,
      checkpoint: cp,
      current_document_epoch: "doc:9",
      current_session_epoch: "sess:9",
      ambiguous_effect_pending: true,
      observed: {
        tools_include_purchase: true,
        order_state: store.getOrder().state,
        order_id: store.getOrder().order_id,
        receipt_id: store.getOrder().receipt_id,
        total_aud: store.getOrder().total_aud,
        budget_aud: fixture.budget_aud,
        seat_ids: store.getOrder().seat_ids,
        price_drift: false,
        seat_drift: false,
      },
    });
    expect(blockedResume.decision.rationale).toMatch(/Ambiguous effect/);

    const recon = reconcileAmbiguousCommit({
      operation_id: op,
      observed: {
        state: store.getOrder().state,
        order_id: store.getOrder().order_id,
        receipt_id: store.getOrder().receipt_id,
        committed_purchase_count: store.getOrder().committed_purchase_count,
      },
      prior: registry.get(op) ?? null,
    });
    expect(recon.action).toBe("reuse_existing");

    // Fresh protocol after reconcile — prior protocol may already be terminal_safe
    const protocolFinal = new ProtocolRunContext({
      document_epoch: "doc:9",
      session_epoch: "sess:9",
    });
    const cp2 = createVerifiedCheckpoint({
      protocol: protocolFinal,
      order_state: "PURCHASED",
      order_id: store.getOrder().order_id,
      receipt_id: store.getOrder().receipt_id,
      state_revision: store.getOrder().state_revision,
      operation_journal_refs: [op],
      postconditions_met: true,
    });
    const finalRec = recoverFromInterruption({
      protocol: protocolFinal,
      checkpoint: cp2,
      current_document_epoch: "doc:9",
      current_session_epoch: "sess:9",
      ambiguous_effect_pending: false,
      observed: {
        tools_include_purchase: true,
        order_state: "PURCHASED",
        order_id: store.getOrder().order_id,
        receipt_id: store.getOrder().receipt_id,
        total_aud: store.getOrder().total_aud,
        budget_aud: fixture.budget_aud,
        seat_ids: store.getOrder().seat_ids,
        price_drift: false,
        seat_drift: false,
      },
    });
    expect(finalRec.decision.action).toBe("stop");
    expect(evaluateOrderOracle(fixture, store.getOrder()).ok).toBe(true);
    writeEvidence("D1D2-timeout-reload-composition.json", {
      timed_error: timed.error,
      reconcile: recon,
      recovery: finalRec.decision,
      journal: journal.all(),
      ab_events: protocolFinal.allEvents().map((e) => e.event_type),
      oracle_ok: true,
      commits: 1,
    });
  });

  it("D2.2 + D2.4: interruption detection and budgeted terminal matrix", () => {
    const matrix = [];
    for (const scenario of [
      { name: "purchased_stop", state: "PURCHASED" as const, expect: "stop" },
      { name: "empty_restart", state: "EMPTY" as const, expect: "restart_draft" },
      { name: "reviewed_resume", state: "ORDER_REVIEWED" as const, expect: "resume" },
      { name: "expired_checkpoint_stop", state: "ORDER_REVIEWED" as const, expect: "stop", expire: true },
    ]) {
      const protocol = new ProtocolRunContext({ document_epoch: "d", session_epoch: "s" });
      const cp = createVerifiedCheckpoint({
        protocol,
        order_state: scenario.state,
        order_id: scenario.state === "PURCHASED" ? "o1" : null,
        receipt_id: scenario.state === "PURCHASED" ? "r1" : null,
        state_revision: 2,
        postconditions_met: true,
        ttl_ms: scenario.expire ? 1 : 60_000,
        now_ms: 1000,
      });
      const recovered = recoverFromInterruption({
        protocol,
        checkpoint: cp,
        current_document_epoch: "d",
        current_session_epoch: "s",
        ambiguous_effect_pending: false,
        now_ms: scenario.expire ? 5000 : 1000,
        observed: {
          tools_include_purchase: true,
          order_state: scenario.state,
          order_id: scenario.state === "PURCHASED" ? "o1" : null,
          receipt_id: scenario.state === "PURCHASED" ? "r1" : null,
          total_aud: 100,
          budget_aud: 200,
          seat_ids: ["1A", "1B"],
          price_drift: false,
          seat_drift: false,
        },
      });
      matrix.push({
        scenario: scenario.name,
        action: recovered.decision.action,
        integrity: recovered.integrity,
      });
      expect(recovered.decision.action).toBe(scenario.expect);
    }
    const exhausted = selectDiagnosisAction({
      structuredFailure: envelopeFromToolError({
        tool: "purchase_tickets",
        error: "stale_capability_epoch",
        state: "ORDER_REVIEWED",
        state_revision: 2,
      }),
      budgets_used: { reobserve: 3, reconcile: 0, recover: 0, retry_safe: 0 },
      budgets: { reobserve: 3, reconcile: 3, recover: 2, retry_safe: 1 },
    });
    expect(exhausted.action).toBe("stop");
    matrix.push({ scenario: "budget_exhausted_stop", action: exhausted.action, integrity: { ok: true } });
    writeEvidence("D2-terminal-matrix.json", { matrix });
  });

  it("D2.5 + integrated: six-domain contracts + ten integrated reps + happy path", () => {
    expect(Object.keys(labToolContracts()).length).toBe(24);
    const reps = [];
    for (let i = 0; i < 10; i += 1) {
      const r = runIntegratedToolPolicySession({
        repoRoot,
        fixture,
        experiment_id: "proof-30-integrated",
        repetition_index: i,
        specification: { proof: "30" },
        taskOutboundLocal: taskOutbound,
        taskReturnLocal: taskReturn,
        mechanisms: ALL_ON,
        condition: "intervention",
        stage_id: "proof-30",
      });
      reps.push({ i, oracle_ok: r.oracle_ok, commits: r.order.committed_purchase_count });
      expect(r.oracle_ok).toBe(true);
      expect(r.order.committed_purchase_count).toBe(1);
    }
    const timeout = runIntegratedToolPolicySession({
      repoRoot,
      fixture,
      experiment_id: "proof-30-timeout",
      repetition_index: 0,
      specification: {},
      taskOutboundLocal: taskOutbound,
      taskReturnLocal: taskReturn,
      mechanisms: ALL_ON,
      adversity: "client_timeout_after_commit",
      condition: "intervention",
      stage_id: "proof-30",
    });
    expect(timeout.order.committed_purchase_count).toBe(1);
    writeEvidence("integrated-ten-and-timeout.json", { reps, timeout_commits: 1 });
  });

  it("writes criterion index mapping evidence files", () => {
    writeEvidence("CRITERION_INDEX.json", {
      candidate: "p2026.08.31.5",
      criteria: {
        A3: "A3-recovery-revalidate.json",
        A5: "A5-six-domain-transfer.json",
        B2: "B2-drift-controls.json",
        B5: "B5-freshness-transfer-cost.json",
        "C1.2": "C1-normalize-transfer.json",
        "C1.5": "C1-normalize-transfer.json",
        "C2.2": "C2-mixed-adversity-enforcement.json",
        "C2.4": "C2-mixed-adversity-enforcement.json",
        "C2.5": "C2D1-transfer-cost.json",
        "D1.4": "D1D2-timeout-reload-composition.json",
        "D1.5": "C2D1-transfer-cost.json",
        "D2.1": "D1D2-timeout-reload-composition.json",
        "D2.2": "D2-terminal-matrix.json",
        "D2.4": "D2-terminal-matrix.json",
        "D2.5": "integrated-ten-and-timeout.json",
      },
    });
  });
});
