/**
 * Codex agent session that applies Critiqor playbook after tool failures.
 */

import type { Fixture, Journey } from "../domain/types.ts";
import { EventRecorder, invokeTool } from "../domain/harness.ts";
import { ReliableRailStore } from "../domain/store.ts";
import { evaluateOrderOracle } from "../domain/oracle.ts";
import type { EffectRecord } from "../../../reliability-boundary/effect/effectSafety.ts";
import type { DiagnosisDecision } from "../../../reliability-boundary/diagnosis/diagnosisPolicy.ts";
import {
  ALL_MECHANISMS_ON,
  type MechanismFlags,
} from "./integratedSession.ts";
import { writeSessionArtifacts, type SessionResult, type SessionSpec } from "./sessionRunner.ts";
import {
  applyCritiqorPlaybook,
  emptyPlaybookOutcome,
  CRITIQOR_PLAYBOOK_RULES,
  type PlaybookOutcome,
} from "./codexPlaybook.ts";

type SearchData = { journeys: Journey[] };
type SeatData = { adjacent_pairs: string[][] };

function localStamp(iso: string): string {
  return iso.slice(0, 16);
}

export function runCodexPlaybookSession(options: {
  repoRoot: string;
  fixture: Fixture;
  experiment_id: string;
  repetition_index: number;
  specification: unknown;
  taskOutboundLocal: string;
  taskReturnLocal: string;
  mechanisms?: MechanismFlags;
  adversity?: "none" | "client_timeout_after_commit" | "stale_epoch_then_refresh";
  playbookEnabled?: boolean;
}): SessionResult & { playbook: PlaybookOutcome } {
  const mechanisms = options.mechanisms ?? ALL_MECHANISMS_ON;
  const playbookEnabled = options.playbookEnabled !== false;
  const store = new ReliableRailStore(options.fixture);
  const recorder = new EventRecorder();
  const registry = new Map<string, EffectRecord>();
  const playbook = emptyPlaybookOutcome();
  const stage = "codex-playbook";

  let expectedEpoch = "epoch:stable";
  let actualEpoch = "epoch:stable";
  if (options.adversity === "stale_epoch_then_refresh") {
    expectedEpoch = "epoch:discovered";
    actualEpoch = "epoch:after_toolchange";
  }

  const invokeOpts = {
    contractConformance: mechanisms.contract_conformance,
    capabilityFreshness: mechanisms.capability_freshness,
    structuredSemantics: mechanisms.structured_semantics,
    diagnosisPolicy: mechanisms.diagnosis_policy,
    effectSafety: mechanisms.effect_safety,
    effectRegistry: registry,
    expectedCapabilityEpoch: expectedEpoch,
    actualCapabilityEpoch: actualEpoch,
    simulateClientTimeoutAfterCommit:
      options.adversity === "client_timeout_after_commit",
  };

  const spec: SessionSpec = {
    experiment_id: options.experiment_id,
    stage_id: "codex-playbook",
    condition: "intervention",
    agent_profile_version: "agent.codex-planner.v1-playbook",
    prompt_version: "prompt.codex-planner.v1-playbook",
    environment_fixture_version: options.fixture.fixture_version,
    mechanism_flags: { ...mechanisms },
    adversity_scenario_version: options.adversity ?? "none",
    repetition_index: options.repetition_index,
    runtime_lane: "native-requested",
  };

  const call = (
    name: Parameters<typeof invokeTool>[2],
    input: Record<string, unknown> = {},
    extra: Partial<typeof invokeOpts> = {},
  ) => invokeTool(store, recorder, name, input, stage, { ...invokeOpts, ...extra });

  recorder.record({
    component: "agent",
    stage,
    event_type: "agent_intent",
    payload: {
      agent_profile_version: "agent.codex-planner.v1-playbook",
      execution_engine: "codex-playbook-v1",
      critiqor_playbook_rules: CRITIQOR_PLAYBOOK_RULES,
      playbook_enabled: playbookEnabled,
    },
  });

  call("reset_fixture");

  const outboundSearch = call("search_journeys", {
    origin: options.fixture.origin,
    destination: options.fixture.destination,
    direction: "outbound",
  });
  const returnSearch = call("search_journeys", {
    origin: options.fixture.destination,
    destination: options.fixture.origin,
    direction: "return",
  });
  const outboundJourneys =
    (outboundSearch.data as SearchData | undefined)?.journeys ?? [];
  const returnJourneys = (returnSearch.data as SearchData | undefined)?.journeys ?? [];
  const outbound = outboundJourneys.find(
    (j) => localStamp(j.depart_at) === options.taskOutboundLocal,
  );
  const ret = returnJourneys.find(
    (j) => localStamp(j.depart_at) === options.taskReturnLocal,
  );

  if (!outbound || !ret) {
    const order = store.getOrder();
    const oracle = evaluateOrderOracle(options.fixture, order);
    const written = writeSessionArtifacts({
      repoRoot: options.repoRoot,
      spec,
      specification: options.specification,
      recorder,
      order,
      oracle,
      status: "included-task-failure",
      metrics: { task_success: false, playbook_followed: playbook.followed },
      extra: { playbook, failure: "search_mismatch" },
    });
    return { ...written, playbook };
  }

  call("select_journey", {
    outbound_journey_id: outbound.journey_id,
    return_journey_id: ret.journey_id,
  });
  const seatsResult = call("list_available_seats");
  const pair = (seatsResult.data as SeatData | undefined)?.adjacent_pairs?.[0];
  if (!pair) {
    const order = store.getOrder();
    const oracle = evaluateOrderOracle(options.fixture, order);
    const written = writeSessionArtifacts({
      repoRoot: options.repoRoot,
      spec,
      specification: options.specification,
      recorder,
      order,
      oracle,
      status: "included-task-failure",
      metrics: { task_success: false },
      extra: { playbook, failure: "no_seats" },
    });
    return { ...written, playbook };
  }
  call("reserve_seats", { seat_ids: pair });
  call("review_order");

  const opId = `op_playbook_r${options.repetition_index}`;
  let purchase = call("purchase_tickets", { operation_id: opId });

  if (!purchase.ok) {
    const diagnosis = (purchase.data as { diagnosis_action?: DiagnosisDecision } | undefined)
      ?.diagnosis_action;
    const step = playbookEnabled
      ? applyCritiqorPlaybook({
          diagnosis: diagnosis ?? null,
          error: purchase.error,
          hasStructuredFailure: Boolean(
            (purchase.data as { structured_failure?: unknown } | undefined)?.structured_failure,
          ),
        })
      : {
          action: "retry" as const,
          rationale: "playbook disabled — naive retry",
          from_critiqor_playbook: false,
        };
    playbook.steps.push(step);
    recorder.record({
      component: "agent",
      stage,
      event_type: "playbook_decision",
      payload: step,
    });

    if (!playbookEnabled) {
      playbook.blind_retry_attempted = true;
      playbook.followed = false;
      purchase = call("purchase_tickets", { operation_id: `${opId}_blind` });
    } else if (step.action === "refresh_epoch") {
      // Replay evidence: rediscover by aligning epoch, then one controlled retry
      expectedEpoch = "epoch:refreshed";
      actualEpoch = "epoch:refreshed";
      invokeOpts.expectedCapabilityEpoch = expectedEpoch;
      invokeOpts.actualCapabilityEpoch = actualEpoch;
      recorder.record({
        component: "agent",
        stage,
        event_type: "reobserve",
        payload: { expectedEpoch, actualEpoch },
      });
      purchase = call("purchase_tickets", { operation_id: opId });
      playbook.recovered = purchase.ok === true;
    } else if (step.action === "reconcile") {
      call("get_order", { operation_id: opId });
      playbook.recovered = store.getOrder().committed_purchase_count === 1;
    } else if (step.action === "stop" || step.action === "escalate" || step.action === "inspect_evidence") {
      playbook.halted = true;
      // Explicitly do not blind-retry
    } else if (step.action === "retry") {
      playbook.blind_retry_attempted = true;
      playbook.followed = false;
      purchase = call("purchase_tickets", { operation_id: `${opId}_retry` });
    }
  }

  // Always attempt a duplicate to prove ≤1
  const duplicate = call("purchase_tickets", { operation_id: `${opId}_dup` });
  call("get_order", { operation_id: opId });

  const order = store.getOrder();
  const oracle = evaluateOrderOracle(options.fixture, order);
  const written = writeSessionArtifacts({
    repoRoot: options.repoRoot,
    spec,
    specification: options.specification,
    recorder,
    order,
    oracle,
    status: oracle.ok ? "included-success" : "included-task-failure",
    metrics: {
      task_success: oracle.ok,
      committed_purchase_count: order.committed_purchase_count,
      duplicate_effect_count:
        order.committed_purchase_count > 1 ? order.committed_purchase_count - 1 : 0,
      duplicate_rejected: duplicate.ok === false,
      playbook_followed: playbook.followed,
      playbook_halted: playbook.halted,
      playbook_recovered: playbook.recovered,
      blind_retry_attempted: playbook.blind_retry_attempted,
      first_purchase_ok: purchase.ok,
    },
    extra: { playbook, mechanisms },
  });
  return { ...written, playbook };
}
