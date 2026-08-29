/**
 * WebMCP struggle battery as executable vitest suite (sandbox-friendly).
 * Codex profile label; Critiqor event export for dashboard ingestion.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALL_MECHANISMS_OFF,
  ALL_MECHANISMS_ON,
  runIntegratedToolPolicySession,
} from "../src/harness/integratedSession.ts";
import { EventRecorder, invokeTool } from "../src/domain/harness.ts";
import { ReliableRailStore } from "../src/domain/store.ts";
import { evaluateOrderOracle } from "../src/domain/oracle.ts";
import { decideRecovery } from "../../reliability-boundary/recovery/stateRecovery.ts";
import { exportEventsToCritiqorJsonl } from "../../../adapters/critiqor/mapEvents.ts";
import type { EffectRecord } from "../../reliability-boundary/effect/effectSafety.ts";
import type { Fixture } from "../src/domain/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const fixture = JSON.parse(
  readFileSync(join(repoRoot, "configurations/fixtures/fixture-v0.json"), "utf8"),
) as Fixture;
const taskOutbound = fixture.task_target.outbound_depart_local.slice(0, 16);
const taskReturn = fixture.task_target.return_depart_local.slice(0, 16);

type CaseResult = {
  case_id: string;
  struggle: string;
  webmcp_precedent: string;
  mechanisms: "off" | "on";
  agent_profile: string;
  oracle_ok: boolean;
  committed_purchase_count: number;
  status: string;
  notes: string[];
  artifact_dir?: string;
  recovery_action?: string | null;
};

const results: CaseResult[] = [];

describe("WebMCP struggle battery (Codex profile)", () => {
  it("runs planned adversities and exports Critiqor events", () => {
    // baseline
    {
      const r = runIntegratedToolPolicySession({
        repoRoot,
        fixture,
        experiment_id: "struggle-baseline-happy",
        repetition_index: 1,
        specification: { agent: "agent.codex-planner.v0" },
        taskOutboundLocal: taskOutbound,
        taskReturnLocal: taskReturn,
        mechanisms: ALL_MECHANISMS_OFF,
        agent_profile_version: "agent.codex-planner.v0",
        condition: "baseline",
        stage_id: "struggle-battery",
      });
      results.push({
        case_id: "baseline-happy",
        struggle: "Control — no adversity",
        webmcp_precedent: "n/a",
        mechanisms: "off",
        agent_profile: "agent.codex-planner.v0",
        oracle_ok: r.oracle_ok,
        committed_purchase_count: r.order.committed_purchase_count,
        status: r.status,
        notes: ["Codex profile label; tool-policy engine in sandbox"],
        artifact_dir: r.artifact_dir,
      });
      expect(r.oracle_ok).toBe(true);
    }

    // capability churn
    {
      const store = new ReliableRailStore(fixture);
      const recorder = new EventRecorder();
      const registry = new Map<string, EffectRecord>();
      invokeTool(store, recorder, "reset_fixture", {}, "struggle-churn");
      invokeTool(
        store,
        recorder,
        "select_journey",
        {
          outbound_journey_id: fixture.task_target.outbound_journey_id,
          return_journey_id: fixture.task_target.return_journey_id,
        },
        "struggle-churn",
        { contractConformance: true },
      );
      invokeTool(
        store,
        recorder,
        "reserve_seats",
        { seat_ids: fixture.default_adjacent_pair },
        "struggle-churn",
        { contractConformance: true },
      );
      invokeTool(store, recorder, "review_order", {}, "struggle-churn", {
        contractConformance: true,
      });
      const blocked = invokeTool(
        store,
        recorder,
        "purchase_tickets",
        { operation_id: "op_stale" },
        "struggle-churn",
        {
          contractConformance: true,
          capabilityFreshness: true,
          structuredSemantics: true,
          diagnosisPolicy: true,
          effectSafety: true,
          effectRegistry: registry,
          expectedCapabilityEpoch: "epoch:discovered",
          actualCapabilityEpoch: "epoch:after_toolchange",
        },
      );
      const outDir = join(
        repoRoot,
        "artifacts/experiments/struggle-capability-churn/intervention",
      );
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "events.jsonl"), recorder.toJsonl());
      writeFileSync(
        join(outDir, "critiqor-events.jsonl"),
        exportEventsToCritiqorJsonl(recorder.all()),
      );
      expect(blocked.ok).toBe(false);
      expect(blocked.error).toBe("stale_capability_epoch");
      expect(store.getOrder().committed_purchase_count).toBe(0);
      results.push({
        case_id: "capability-churn",
        struggle:
          "Tool list / capability revision after discovery; stale consequential call",
        webmcp_precedent:
          "tools/list_changed asymmetry; Chrome may list tools but not invoke",
        mechanisms: "on",
        agent_profile: "agent.codex-planner.v0",
        oracle_ok: false,
        committed_purchase_count: 0,
        status: "safe-reject",
        notes: [
          `error=${blocked.error}`,
          `diagnosis=${JSON.stringify((blocked.data as { diagnosis_action?: unknown })?.diagnosis_action ?? null)}`,
        ],
        artifact_dir: outDir,
      });
    }

    // timeout ambiguous commit
    {
      const r = runIntegratedToolPolicySession({
        repoRoot,
        fixture,
        experiment_id: "struggle-timeout-ambiguous-commit",
        repetition_index: 1,
        specification: { agent: "agent.codex-planner.v0" },
        taskOutboundLocal: taskOutbound,
        taskReturnLocal: taskReturn,
        mechanisms: ALL_MECHANISMS_ON,
        agent_profile_version: "agent.codex-planner.v0",
        condition: "intervention",
        stage_id: "struggle-battery",
        adversity: "client_timeout_after_commit",
      });
      expect(r.order.committed_purchase_count).toBe(1);
      expect(r.oracle_ok).toBe(true);
      results.push({
        case_id: "timeout-ambiguous-commit",
        struggle:
          "Cancellation/timeout after may-have-committed purchase (unmount analogy)",
        webmcp_precedent:
          "React unmount cancels in-flight; cancellation not a safe assumption",
        mechanisms: "on",
        agent_profile: "agent.codex-planner.v0",
        oracle_ok: r.oracle_ok,
        committed_purchase_count: r.order.committed_purchase_count,
        status: r.status,
        notes: ["reconcile-before-retry; ≤1 purchase"],
        artifact_dir: r.artifact_dir,
      });
    }

    // opaque failure
    {
      const store = new ReliableRailStore(fixture);
      const recorder = new EventRecorder();
      invokeTool(store, recorder, "reset_fixture", {}, "struggle-opaque");
      recorder.record({
        component: "webmcp",
        stage: "struggle-opaque",
        event_type: "tool_result",
        payload: {
          tool: "purchase_tickets",
          ok: false,
          error: "Error",
          structured_failure: null,
          note: "opaque_browser_or_site_failure",
        },
      });
      const withMech = invokeTool(store, recorder, "purchase_tickets", {}, "struggle-opaque", {
        contractConformance: true,
        structuredSemantics: true,
        diagnosisPolicy: true,
      });
      const outDir = join(
        repoRoot,
        "artifacts/experiments/struggle-opaque-failure/intervention",
      );
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "events.jsonl"), recorder.toJsonl());
      writeFileSync(
        join(outDir, "critiqor-events.jsonl"),
        exportEventsToCritiqorJsonl(recorder.all()),
      );
      results.push({
        case_id: "opaque-failure",
        struggle: "Opaque tool/runtime errors that look like generic Error",
        webmcp_precedent: "Missing structured failure semantics; console/tool ambiguity",
        mechanisms: "on",
        agent_profile: "agent.codex-planner.v0",
        oracle_ok: false,
        committed_purchase_count: 0,
        status: "safe-stop-or-incomplete",
        notes: [
          `diagnosis=${JSON.stringify((withMech.data as { diagnosis_action?: unknown })?.diagnosis_action ?? null)}`,
        ],
        artifact_dir: outDir,
      });
    }

    // reload after purchase
    {
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
        expectedCapabilityEpoch: "epoch:stable",
        actualCapabilityEpoch: "epoch:stable",
      };
      const call = (
        name: Parameters<typeof invokeTool>[2],
        input: Record<string, unknown> = {},
      ) => invokeTool(store, recorder, name, input, "struggle-reload", opts);
      call("reset_fixture");
      call("select_journey", {
        outbound_journey_id: fixture.task_target.outbound_journey_id,
        return_journey_id: fixture.task_target.return_journey_id,
      });
      call("reserve_seats", { seat_ids: fixture.default_adjacent_pair });
      call("review_order");
      call("purchase_tickets", { operation_id: "op_reload_1" });
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
      recorder.record({
        component: "harness",
        stage: "struggle-reload",
        event_type: "recovery_decision",
        payload: { ...decision, adversity: "reload_after_purchase" },
      });
      const dup = call("purchase_tickets", { operation_id: "op_reload_2" });
      expect(decision.action).toBe("stop");
      expect(dup.ok).toBe(false);
      expect(store.getOrder().committed_purchase_count).toBe(1);
      const outDir = join(
        repoRoot,
        "artifacts/experiments/struggle-reload-after-purchase/intervention",
      );
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "events.jsonl"), recorder.toJsonl());
      writeFileSync(
        join(outDir, "critiqor-events.jsonl"),
        exportEventsToCritiqorJsonl(recorder.all()),
      );
      results.push({
        case_id: "reload-after-purchase",
        struggle: "Reload/navigation after consequential action; URL is not sole state",
        webmcp_precedent: "Relay rediscovery + unmount-during-async",
        mechanisms: "on",
        agent_profile: "agent.codex-planner.v0",
        oracle_ok: evaluateOrderOracle(fixture, store.getOrder()).ok,
        committed_purchase_count: 1,
        status: "included-success",
        notes: [`recovery_action=${decision.action}`, `duplicate_rejected=${!dup.ok}`],
        artifact_dir: outDir,
        recovery_action: decision.action,
      });
    }

    // lane mismatch fail-closed
    {
      const recorder = new EventRecorder();
      recorder.record({
        component: "harness",
        stage: "struggle-lane",
        event_type: "runtime_lane",
        payload: {
          requested: "native",
          actual: "polyfill-compatibility",
          fail_closed: true,
        },
      });
      const outDir = join(
        repoRoot,
        "artifacts/experiments/struggle-lane-mismatch/intervention",
      );
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "events.jsonl"), recorder.toJsonl());
      writeFileSync(
        join(outDir, "critiqor-events.jsonl"),
        exportEventsToCritiqorJsonl(recorder.all()),
      );
      results.push({
        case_id: "lane-mismatch",
        struggle: "Native vs polyfill/headless asymmetry; fail-closed",
        webmcp_precedent: "MCP-B / relay headless vs headed reports",
        mechanisms: "on",
        agent_profile: "agent.codex-planner.v0",
        oracle_ok: false,
        committed_purchase_count: 0,
        status: "fail-closed-no-run",
        notes: ["Mode fail-closed; session not executed under mismatched lane"],
        artifact_dir: outDir,
      });
    }

    // fullstack happy
    {
      const r = runIntegratedToolPolicySession({
        repoRoot,
        fixture,
        experiment_id: "struggle-fullstack-happy",
        repetition_index: 1,
        specification: { agent: "agent.codex-planner.v0" },
        taskOutboundLocal: taskOutbound,
        taskReturnLocal: taskReturn,
        mechanisms: ALL_MECHANISMS_ON,
        agent_profile_version: "agent.codex-planner.v0",
        condition: "intervention",
        stage_id: "struggle-battery",
      });
      expect(r.oracle_ok).toBe(true);
      results.push({
        case_id: "fullstack-happy",
        struggle: "Control — all mechanisms, no adversity",
        webmcp_precedent: "n/a",
        mechanisms: "on",
        agent_profile: "agent.codex-planner.v0",
        oracle_ok: r.oracle_ok,
        committed_purchase_count: r.order.committed_purchase_count,
        status: r.status,
        notes: ["A–D2 assembled"],
        artifact_dir: r.artifact_dir,
      });
    }

    const summaryDir = join(repoRoot, "artifacts/experiments/struggle-battery-v0");
    mkdirSync(summaryDir, { recursive: true });
    writeFileSync(
      join(summaryDir, "RESULTS.json"),
      JSON.stringify({ generated_at: new Date().toISOString(), agent: "codex-planner", results }, null, 2),
    );
    const merged: string[] = [];
    for (const r of results) {
      if (!r.artifact_dir) continue;
      const p = join(r.artifact_dir, "critiqor-events.jsonl");
      if (existsSync(p)) {
        const text = readFileSync(p, "utf8").trim();
        if (text) merged.push(text);
      }
    }
    writeFileSync(join(summaryDir, "critiqor-events.jsonl"), merged.join("\n") + "\n");
    expect(results.length).toBeGreaterThanOrEqual(6);
  });
});
