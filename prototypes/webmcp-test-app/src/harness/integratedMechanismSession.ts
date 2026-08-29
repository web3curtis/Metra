/**
 * Integrated A–D2 mechanism session via reference tool-policy (deterministic).
 * Proves switchable stack can complete the fixed purchase task.
 */

import type { Fixture, Journey } from "../domain/types.ts";
import { EventRecorder, invokeTool } from "../domain/harness.ts";
import { ReliableRailStore } from "../domain/store.ts";
import { evaluateOrderOracle } from "../domain/oracle.ts";
import { decideRecovery } from "../../../reliability-boundary/recovery/stateRecovery.ts";
import type { EffectRecord } from "../../../reliability-boundary/effect/effectSafety.ts";
import {
  writeSessionArtifacts,
  type SessionResult,
  type SessionSpec,
} from "./sessionRunner.ts";

type SearchData = { journeys: Journey[] };
type SeatData = { adjacent_pairs: string[][] };

function localStamp(iso: string): string {
  return iso.slice(0, 16);
}

export function runIntegratedMechanismSession(options: {
  repoRoot: string;
  fixture: Fixture;
  experiment_id: string;
  repetition_index: number;
  specification: unknown;
  taskOutboundLocal: string;
  taskReturnLocal: string;
  /** Simulate reload mid-flow before purchase */
  simulateReloadBeforePurchase?: boolean;
}): SessionResult {
  const store = new ReliableRailStore(options.fixture);
  const recorder = new EventRecorder();
  const registry = new Map<string, EffectRecord>();
  const stage = "integrated-a-d2";
  const invokeOpts = {
    contractConformance: true,
    capabilityFreshness: true,
    structuredSemantics: true,
    diagnosisPolicy: true,
    effectSafety: true,
    effectRegistry: registry,
    expectedCapabilityEpoch: "epoch:integrated",
    actualCapabilityEpoch: "epoch:integrated",
  };

  const spec: SessionSpec = {
    experiment_id: options.experiment_id,
    stage_id: "integration",
    condition: "intervention",
    agent_profile_version: "agent.reference-planner.v0",
    prompt_version: "prompt.reference-planner.v0",
    environment_fixture_version: options.fixture.fixture_version,
    mechanism_flags: {
      contract_conformance: true,
      capability_freshness: true,
      structured_semantics: true,
      diagnosis_policy: true,
      effect_safety: true,
      state_recovery: true,
    },
    adversity_scenario_version: options.simulateReloadBeforePurchase
      ? "reload-before-purchase-v0"
      : "none",
    repetition_index: options.repetition_index,
    runtime_lane: "integrated-tool-policy-v0",
  };

  const call = (
    name: Parameters<typeof invokeTool>[2],
    input: Record<string, unknown> = {},
  ) => invokeTool(store, recorder, name, input, stage, invokeOpts);

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
  const outbound = ((outboundSearch.data as SearchData | undefined)?.journeys ?? []).find(
    (j) => localStamp(j.depart_at) === options.taskOutboundLocal,
  );
  const ret = ((returnSearch.data as SearchData | undefined)?.journeys ?? []).find(
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
      extra: { failure: "search_mismatch" },
    });
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
    return writeSessionArtifacts({
      repoRoot: options.repoRoot,
      spec,
      specification: options.specification,
      recorder,
      order,
      oracle,
      status: "included-task-failure",
      metrics: { task_success: false },
      extra: { failure: "no_seats" },
    });
  }
  call("reserve_seats", { seat_ids: pair });
  call("review_order");

  if (options.simulateReloadBeforePurchase) {
    const observed = store.getOrder();
    const recovery = decideRecovery({
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
    recorder.record({
      component: "harness",
      stage,
      event_type: "state_recovery_decision",
      payload: { recovery },
    });
    if (recovery.action !== "resume") {
      const oracle = evaluateOrderOracle(options.fixture, observed);
      return writeSessionArtifacts({
        repoRoot: options.repoRoot,
        spec,
        specification: options.specification,
        recorder,
        order: observed,
        oracle,
        status: "included-safe-failure",
        metrics: { task_success: false, recovery_action_resume: 0 },
        extra: { recovery },
      });
    }
  }

  call("purchase_tickets", { operation_id: `op_int_${options.repetition_index}` });
  call("purchase_tickets", { operation_id: `op_int_dup_${options.repetition_index}` });
  call("get_order", { operation_id: `op_int_${options.repetition_index}` });

  const order = store.getOrder();
  const oracle = evaluateOrderOracle(options.fixture, order);
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
      committed_purchase_count: order.committed_purchase_count,
    },
    extra: { execution_engine: "integrated-tool-policy-v0", mechanisms: "A-D2" },
  });
}
