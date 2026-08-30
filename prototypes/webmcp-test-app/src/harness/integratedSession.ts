/**
 * Integrated A–D2 mechanism session (deterministic tool policy).
 * Used for regression + generalization control profiles.
 */

import type { Fixture, Journey } from "../domain/types.ts";
import { EventRecorder, invokeTool } from "../domain/harness.ts";
import { ReliableRailStore } from "../domain/store.ts";
import { evaluateOrderOracle } from "../domain/oracle.ts";
import { decideRecovery } from "../../../reliability-boundary/recovery/stateRecovery.ts";
import type { EffectRecord } from "../../../reliability-boundary/effect/effectSafety.ts";
import { writeSessionArtifacts, type SessionResult, type SessionSpec } from "./sessionRunner.ts";

export type MechanismFlags = {
  contract_conformance: boolean;
  capability_freshness: boolean;
  structured_semantics: boolean;
  diagnosis_policy: boolean;
  effect_safety: boolean;
  state_recovery: boolean;
};

type SearchData = { journeys: Journey[] };
type SeatData = { adjacent_pairs: string[][] };

function localStamp(iso: string): string {
  return iso.slice(0, 16);
}

export const ALL_MECHANISMS_ON: MechanismFlags = {
  contract_conformance: true,
  capability_freshness: true,
  structured_semantics: true,
  diagnosis_policy: true,
  effect_safety: true,
  state_recovery: true,
};

export const ALL_MECHANISMS_OFF: MechanismFlags = {
  contract_conformance: false,
  capability_freshness: false,
  structured_semantics: false,
  diagnosis_policy: false,
  effect_safety: false,
  state_recovery: false,
};

export function runIntegratedToolPolicySession(options: {
  repoRoot: string;
  fixture: Fixture;
  experiment_id: string;
  repetition_index: number;
  specification: unknown;
  taskOutboundLocal: string;
  taskReturnLocal: string;
  mechanisms: MechanismFlags;
  agent_profile_version?: string;
  condition?: "baseline" | "intervention";
  stage_id?: string;
  preferAlternateSeats?: boolean;
  adversity?:
    | "none"
    | "client_timeout_after_commit"
    | "reload_after_review"
    | "duplicate_purchase_probe";
  /** Epoch pair for freshness gate when capability_freshness on and no adversity */
  capabilityEpochs?: { expected: string; actual: string };
}): SessionResult {
  const store = new ReliableRailStore(options.fixture);
  const recorder = new EventRecorder();
  const registry = new Map<string, EffectRecord>();
  const stage = options.stage_id ?? "integrated";
  const agentProfile = options.agent_profile_version ?? "agent.reference-planner.v0";
  const epochs = options.capabilityEpochs ?? {
    expected: "epoch:stable",
    actual: "epoch:stable",
  };

  const invokeOpts = {
    contractConformance: options.mechanisms.contract_conformance,
    capabilityFreshness: options.mechanisms.capability_freshness,
    structuredSemantics: options.mechanisms.structured_semantics,
    diagnosisPolicy: options.mechanisms.diagnosis_policy,
    effectSafety: options.mechanisms.effect_safety,
    effectRegistry: registry,
    expectedCapabilityEpoch: epochs.expected,
    actualCapabilityEpoch: epochs.actual,
    simulateClientTimeoutAfterCommit:
      options.adversity === "client_timeout_after_commit",
  };

  const allOff = Object.values(options.mechanisms).every((v) => !v);
  const spec: SessionSpec = {
    experiment_id: options.experiment_id,
    stage_id: options.stage_id ?? "integrated",
    condition: options.condition ?? (allOff ? "baseline" : "intervention"),
    agent_profile_version: agentProfile,
    prompt_version: agentProfile.replace("agent.", "prompt."),
    environment_fixture_version: options.fixture.fixture_version,
    mechanism_flags: { ...options.mechanisms },
    adversity_scenario_version: options.adversity ?? "none",
    repetition_index: options.repetition_index,
    runtime_lane: "native-requested",
  };

  const call = (
    name: Parameters<typeof invokeTool>[2],
    input: Record<string, unknown> = {},
    extraOpts: Partial<typeof invokeOpts> = {},
  ) => invokeTool(store, recorder, name, input, stage, { ...invokeOpts, ...extraOpts });

  recorder.record({
    component: "agent",
    stage,
    event_type: "agent_intent",
    payload: {
      agent_profile_version: agentProfile,
      execution_engine: "tool-policy-v0",
      mechanisms: options.mechanisms,
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
    return writeSessionArtifacts({
      repoRoot: options.repoRoot,
      spec,
      specification: options.specification,
      recorder,
      order,
      oracle,
      status: "included-task-failure",
      metrics: { task_success: false },
      extra: { failure: "could_not_match_task_times_from_search" },
    });
  }

  call("select_journey", {
    outbound_journey_id: outbound.journey_id,
    return_journey_id: ret.journey_id,
  });

  const seatsResult = call("list_available_seats");
  const pairs = (seatsResult.data as SeatData | undefined)?.adjacent_pairs ?? [];
  const pairIndex = options.preferAlternateSeats && pairs.length > 1 ? 1 : 0;
  const pair = pairs[pairIndex];
  if (!pair || pair.length < 2) {
    const order = store.getOrder();
    const oracle = evaluateOrderOracle(options.fixture, order);
    return writeSessionArtifacts({
      repoRoot: options.repoRoot,
      spec,
      specification: options.specification,
      recorder,
      order,
      oracle,
      status: "included-task-failure",
      metrics: { task_success: false },
      extra: { failure: "no_adjacent_pair_from_tool" },
    });
  }

  call("reserve_seats", { seat_ids: pair });
  call("review_order");

  let recoveryAction: string | null = null;
  if (options.mechanisms.state_recovery && options.adversity === "reload_after_review") {
    const observed = store.getOrder();
    const decision = decideRecovery({
      tools_include_purchase: true,
      order_state: observed.state,
      order_id: observed.order_id,
      receipt_id: observed.receipt_id,
      total_aud: observed.total_aud,
      budget_aud: options.fixture.budget_aud,
      seat_ids: observed.seat_ids,
      price_drift: false,
      seat_drift: false,
    });
    recoveryAction = decision.action;
    recorder.record({
      component: "harness",
      stage,
      event_type: "recovery_decision",
      payload: decision,
    });
  }

  const opId = `op_${options.experiment_id}_r${options.repetition_index}`;
  // D1 agent-usable: always bind operation_id when effect_safety on
  const purchaseInput = options.mechanisms.effect_safety
    ? { operation_id: opId }
    : {};

  let purchase = call("purchase_tickets", purchaseInput);

  // C2 agent-usable: follow diagnosis_action when present (no blind second purchase except duplicate probe)
  if (
    !purchase.ok &&
    options.mechanisms.diagnosis_policy &&
    options.adversity !== "client_timeout_after_commit"
  ) {
    const diagnosis = (purchase.data as { diagnosis_action?: { action: string } } | undefined)
      ?.diagnosis_action;
    recorder.record({
      component: "agent",
      stage,
      event_type: "playbook_follow",
      payload: { diagnosis, followed: true },
    });
    if (diagnosis?.action === "reobserve") {
      const refreshed = {
        ...invokeOpts,
        expectedCapabilityEpoch: "epoch:refreshed",
        actualCapabilityEpoch: "epoch:refreshed",
      };
      purchase = invokeTool(store, recorder, "purchase_tickets", purchaseInput, stage, refreshed);
    }
    // stop / escalate / other → do not blind-retry before duplicate probe
  }

  if (
    options.mechanisms.effect_safety &&
    options.adversity === "client_timeout_after_commit"
  ) {
    call("get_order", { operation_id: opId });
  }

  // After successful purchase + D2 adversity: re-observe
  if (
    options.mechanisms.state_recovery &&
    options.adversity === "reload_after_review" &&
    store.getOrder().state === "PURCHASED"
  ) {
    const observed = store.getOrder();
    const decision = decideRecovery({
      tools_include_purchase: true,
      order_state: observed.state,
      order_id: observed.order_id,
      receipt_id: observed.receipt_id,
      total_aud: observed.total_aud,
      budget_aud: options.fixture.budget_aud,
      seat_ids: observed.seat_ids,
      price_drift: false,
      seat_drift: false,
    });
    recoveryAction = decision.action;
    recorder.record({
      component: "harness",
      stage,
      event_type: "recovery_decision",
      payload: decision,
    });
  }

  // Duplicate probe only as labelled adversity (not default agent policy)
  const duplicate =
    options.adversity === "duplicate_purchase_probe"
      ? call("purchase_tickets", {
          ...(options.mechanisms.effect_safety ? { operation_id: `${opId}_dup` } : {}),
        })
      : { ok: false as const, error: "duplicate_probe_not_requested" };

  call("get_order", purchaseInput);

  const order = store.getOrder();
  const oracle = evaluateOrderOracle(options.fixture, order);
  const events = recorder.all();
  const toolCalls = events.filter((e) => e.event_type === "tool_call").length;
  const toolResults = events.filter((e) => e.event_type === "tool_result");
  const invalid = toolResults.filter((e) => e.payload.ok === false).length;

  return writeSessionArtifacts({
    repoRoot: options.repoRoot,
    spec,
    specification: options.specification,
    recorder,
    order,
    oracle,
    status: oracle.ok ? "included-success" : "included-task-failure",
    metrics: {
      task_success: oracle.ok,
      duplicate_effect_count:
        order.committed_purchase_count > 1 ? order.committed_purchase_count - 1 : 0,
      purchase_ok: order.committed_purchase_count === 1,
      duplicate_rejected: duplicate.ok === false,
      total_tool_calls: toolCalls,
      invalid_call_rate: toolCalls ? invalid / toolCalls : 0,
      committed_purchase_count: order.committed_purchase_count,
      first_purchase_reported_ok: purchase.ok,
    },
    extra: {
      execution_engine: "tool-policy-v0",
      mechanisms: options.mechanisms,
      recovery_action: recoveryAction,
      selected_from_tools: {
        outbound: outbound.journey_id,
        return: ret.journey_id,
        seats: pair,
      },
    },
  });
}
