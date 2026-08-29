import type { Fixture, Journey } from "../domain/types.ts";
import { EventRecorder, invokeTool } from "../domain/harness.ts";
import { ReliableRailStore } from "../domain/store.ts";
import { evaluateOrderOracle } from "../domain/oracle.ts";
import { writeSessionArtifacts, type SessionResult, type SessionSpec } from "./sessionRunner.ts";

type SearchData = {
  journeys: Journey[];
};

type SeatData = {
  adjacent_pairs: string[][];
};

function localStamp(iso: string): string {
  return iso.slice(0, 16);
}

function baseSpec(
  options: {
    experiment_id: string;
    repetition_index: number;
    fixture: Fixture;
    contractConformance?: boolean;
    condition?: "baseline" | "intervention";
    stage_id?: string;
  },
): SessionSpec {
  const contract = Boolean(options.contractConformance);
  return {
    experiment_id: options.experiment_id,
    stage_id: options.stage_id ?? (contract ? "exp-a" : "baseline"),
    condition: options.condition ?? (contract ? "intervention" : "baseline"),
    agent_profile_version: "agent.reference-planner.v0",
    prompt_version: "prompt.reference-planner.v0",
    environment_fixture_version: options.fixture.fixture_version,
    mechanism_flags: {
      contract_conformance: contract,
      capability_freshness: false,
      structured_semantics: false,
      diagnosis_policy: false,
      effect_safety: false,
      state_recovery: false,
    },
    adversity_scenario_version: "none",
    repetition_index: options.repetition_index,
    runtime_lane: "native-requested",
  };
}

/**
 * Deterministic reference-planner stand-in: uses WebMCP tools only.
 * execution_engine = tool-policy-v0 (not an LLM).
 */
export function runReferenceToolPolicySession(options: {
  repoRoot: string;
  fixture: Fixture;
  experiment_id: string;
  repetition_index: number;
  specification: unknown;
  taskOutboundLocal: string;
  taskReturnLocal: string;
  contractConformance?: boolean;
  condition?: "baseline" | "intervention";
  stage_id?: string;
}): SessionResult {
  const store = new ReliableRailStore(options.fixture);
  const recorder = new EventRecorder();
  const stage = options.contractConformance ? "exp-a-tool-policy" : "baseline-tool-policy";
  const invokeOpts = { contractConformance: Boolean(options.contractConformance) };
  const spec = baseSpec(options);

  const call = (
    name: Parameters<typeof invokeTool>[2],
    input: Record<string, unknown> = {},
  ) => invokeTool(store, recorder, name, input, stage, invokeOpts);

  recorder.record({
    component: "agent",
    stage,
    event_type: "agent_intent",
    payload: {
      agent_profile_version: "agent.reference-planner.v0",
      execution_engine: "tool-policy-v0",
      contract_conformance: invokeOpts.contractConformance,
      note: "Plan then act using only tool outputs; no fixture task_target IDs.",
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
      metrics: { task_success: false, valid_action_rate: 1, invalid_call_rate: 0 },
      extra: {
        execution_engine: "tool-policy-v0",
        failure: "could_not_match_task_times_from_search",
      },
    });
  }

  call("select_journey", {
    outbound_journey_id: outbound.journey_id,
    return_journey_id: ret.journey_id,
  });

  const seatsResult = call("list_available_seats");
  const pair = (seatsResult.data as SeatData | undefined)?.adjacent_pairs?.[0];
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
      extra: { execution_engine: "tool-policy-v0", failure: "no_adjacent_pair_from_tool" },
    });
  }

  call("reserve_seats", { seat_ids: pair });
  call("review_order");
  const purchase = call("purchase_tickets");
  const duplicate = call("purchase_tickets");
  call("get_order");

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
      purchase_ok: purchase.ok,
      duplicate_rejected:
        duplicate.ok === false && duplicate.error === "duplicate_purchase_rejected",
      total_tool_calls: toolCalls,
      invalid_call_rate: toolCalls ? invalid / toolCalls : 0,
      valid_action_rate: toolCalls ? (toolCalls - invalid) / toolCalls : 0,
    },
    extra: {
      execution_engine: "tool-policy-v0",
      contract_conformance: invokeOpts.contractConformance,
      limitation:
        "Deterministic tool policy, not an LLM. LLM/external-agent bridge is a later Yellow task.",
      selected_from_tools: {
        outbound: outbound.journey_id,
        return: ret.journey_id,
        seats: pair,
      },
    },
  });
}
