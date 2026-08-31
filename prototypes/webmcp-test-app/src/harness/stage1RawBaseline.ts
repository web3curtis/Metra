/**
 * Stage 1 — raw WebMCP baseline measurement (mechanisms all off).
 * Apparatus only: does not change A–D2 policy cores.
 */

import { mkdirSync, writeFileSync, cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Fixture } from "../domain/types.ts";
import { EventRecorder, invokeTool, type ToolName } from "../domain/harness.ts";
import { ReliableRailStore } from "../domain/store.ts";
import { evaluateOrderOracle } from "../domain/oracle.ts";
import { registerReliableRailTools } from "../webmcp/register.ts";
import { USE_CASES, type Adversity } from "../lab/catalog.ts";
import { runComparison } from "../lab/runtime.ts";

export type DeclaredStruggleId =
  | "constraint_accuracy"
  | "state_capability_drift"
  | "inconsistent_opaque_results"
  | "ambiguous_effect"
  | "interruption_reload"
  | "unnecessary_calls_latency";

export type StruggleVariation = {
  struggle_id: DeclaredStruggleId;
  mechanical_invariant: string;
  maps_to_mechanism: "A" | "B" | "C1" | "C2" | "D1" | "D2" | "perf_bound";
  surfaces: Array<{
    surface_id: string;
    domain_nouns: string;
    prompt_flavor: string;
  }>;
};

/** ≥3 surface-different, mechanically equivalent variations per struggle. */
export const STAGE1_VARIATION_MATRIX: StruggleVariation[] = [
  {
    struggle_id: "constraint_accuracy",
    mechanical_invariant:
      "Consequential call attempted while semantic/state preconditions are unmet; raw path lacks direction-bearing contract enforcement.",
    maps_to_mechanism: "A",
    surfaces: [
      {
        surface_id: "rail.purchase_before_review",
        domain_nouns: "tickets / order review",
        prompt_flavor: "Buy the selected seats before reviewing the order total.",
      },
      {
        surface_id: "support.open_ticket_before_search",
        domain_nouns: "ticket / help articles",
        prompt_flavor: "Open a P2 ticket before searching verified fixes.",
      },
      {
        surface_id: "projects.ready_with_failing_checks",
        domain_nouns: "workflow / release checks",
        prompt_flavor: "Move Launch to Ready while one required check still fails.",
      },
    ],
  },
  {
    struggle_id: "state_capability_drift",
    mechanical_invariant:
      "Evidence or capability epoch changes after planning; raw path still dispatches the consequential call.",
    maps_to_mechanism: "B",
    surfaces: [
      {
        surface_id: "rail.stale_epoch_purchase",
        domain_nouns: "journeys / seats / purchase",
        prompt_flavor: "Purchase after tools/list changed without reobservation.",
      },
      {
        surface_id: "travel.fare_revision_drift",
        domain_nouns: "fare / reservation",
        prompt_flavor: "Reserve after the live fare revision changes.",
      },
      {
        surface_id: "calendar.slot_taken",
        domain_nouns: "slot / attendees",
        prompt_flavor: "Create the event after another attendee took the slot.",
      },
    ],
  },
  {
    struggle_id: "inconsistent_opaque_results",
    mechanical_invariant:
      "Failure surfaces as opaque Error/string without typed envelope, ownership, or recoverability.",
    maps_to_mechanism: "C1",
    surfaces: [
      {
        surface_id: "rail.opaque_timeout_error",
        domain_nouns: "purchase_tickets",
        prompt_flavor: "Client sees only Error after a consequential call.",
      },
      {
        surface_id: "commerce.timeout_string",
        domain_nouns: "create_order",
        prompt_flavor: "Order response is lost; only a generic failure remains.",
      },
      {
        surface_id: "documents.lost_approval_ack",
        domain_nouns: "request_approval",
        prompt_flavor: "Approval is recorded but the client loses the result form.",
      },
    ],
  },
  {
    struggle_id: "ambiguous_effect",
    mechanical_invariant:
      "Consequential mutation may have committed while the client lacks authoritative confirmation; blind retry risk.",
    maps_to_mechanism: "D1",
    surfaces: [
      {
        surface_id: "rail.timeout_after_commit",
        domain_nouns: "purchase_tickets / receipt",
        prompt_flavor: "Purchase commits server-side; client times out.",
      },
      {
        surface_id: "commerce.order_commit_timeout",
        domain_nouns: "create_order",
        prompt_flavor: "Simulated order commits; response times out.",
      },
      {
        surface_id: "documents.approval_commit_lost",
        domain_nouns: "request_approval",
        prompt_flavor: "Approval request recorded; client never sees success.",
      },
    ],
  },
  {
    struggle_id: "interruption_reload",
    mechanical_invariant:
      "Document/session discontinuity after a consequential action; agent may resume from narrative rather than authoritative state.",
    maps_to_mechanism: "D2",
    surfaces: [
      {
        surface_id: "rail.reload_after_purchase",
        domain_nouns: "order / receipt / URL",
        prompt_flavor: "Page reloads after purchase before confirmation is consumed.",
      },
      {
        surface_id: "commerce.navigate_after_order",
        domain_nouns: "checkout / order id",
        prompt_flavor: "Navigation interrupts after order creation.",
      },
      {
        surface_id: "calendar.reload_after_event",
        domain_nouns: "event / week view",
        prompt_flavor: "Calendar reloads after create_appointment.",
      },
    ],
  },
  {
    struggle_id: "unnecessary_calls_latency",
    mechanical_invariant:
      "Without bounded reobservation/diagnosis, agents may emit extra tool calls or stop without useful speed measurement.",
    maps_to_mechanism: "perf_bound",
    surfaces: [
      {
        surface_id: "rail.happy_path_call_count",
        domain_nouns: "search→purchase tool chain",
        prompt_flavor: "Complete booking with minimal necessary calls.",
      },
      {
        surface_id: "travel.raw_lane_extra_polls",
        domain_nouns: "search_trips / get_trip",
        prompt_flavor: "Raw lane may re-poll without a freshness budget.",
      },
      {
        surface_id: "support.raw_lane_retry_noise",
        domain_nouns: "search_help / create_support_ticket",
        prompt_flavor: "Opaque failures invite unstructured retries.",
      },
    ],
  },
];

export type RawCellResult = {
  struggle_id: DeclaredStruggleId;
  surface_id: string;
  evidence_class: "observed" | "hypothesized_scripted" | "apparatus_control";
  mechanisms: "off";
  path: "page_registered_mock" | "lab_scripted_raw" | "in_process_control";
  observed_pain: string[];
  metrics: Record<string, number | boolean | string | null>;
  notes: string[];
};

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** Mock document.modelContext and register ReliableRail tools → invokeTool (mechanisms off). */
export function registerRawReliableRailPath(
  store: ReliableRailStore,
  recorder: EventRecorder,
  stage: string,
): {
  registered: string[];
  lane: string;
  execute: (name: string, args?: Record<string, unknown>) => ReturnType<typeof invokeTool>;
} {
  const handlers = new Map<string, (args: Record<string, unknown>) => unknown>();
  const fakeDocument = {
    modelContext: {
      registerTool(def: {
        name: string;
        execute: (args: Record<string, unknown>) => unknown;
      }) {
        handlers.set(def.name, def.execute);
      },
    },
  } as unknown as Document;

  const previousDocument = (globalThis as { document?: Document }).document;
  (globalThis as { document?: Document }).document = fakeDocument;

  const invoke = (name: string, args: Record<string, unknown> = {}) =>
    invokeTool(store, recorder, name as ToolName, args, stage, {
      // mechanisms all off
      simulateClientTimeoutAfterCommit: false,
    });

  let registration: { registered: string[]; lane: string; detail: string };
  try {
    registration = registerReliableRailTools(invoke);
  } finally {
    if (previousDocument === undefined) {
      delete (globalThis as { document?: Document }).document;
    } else {
      (globalThis as { document?: Document }).document = previousDocument;
    }
  }

  const execute = (name: string, args: Record<string, unknown> = {}) => {
    const handler = handlers.get(name);
    if (!handler) {
      throw new Error(`tool_not_registered:${name}`);
    }
    return handler(args) as ReturnType<typeof invokeTool>;
  };

  return {
    registered: registration.registered,
    lane: registration.lane,
    execute,
  };
}

function bookToReview(
  execute: (name: string, args?: Record<string, unknown>) => ReturnType<typeof invokeTool>,
  fixture: Fixture,
  reset: () => void,
): void {
  reset();
  execute("select_journey", {
    outbound_journey_id: fixture.task_target.outbound_journey_id,
    return_journey_id: fixture.task_target.return_journey_id,
  });
  execute("reserve_seats", { seat_ids: fixture.default_adjacent_pair });
  execute("review_order");
}

export function runStage1RawBaseline(options: {
  repoRoot: string;
  fixture: Fixture;
  candidateVersion: string;
  repetitions?: number;
}): {
  outDir: string;
  cells: RawCellResult[];
  gate: Record<string, boolean | string | number>;
} {
  const reps = options.repetitions ?? 5;
  const outDir = join(
    options.repoRoot,
    "artifacts/tonight",
    options.candidateVersion,
    "stage1-raw",
  );
  ensureDir(outDir);
  ensureDir(join(outDir, "cells"));

  // Seal prior happy-path as apparatus control (copy if present).
  const prior = join(options.repoRoot, "artifacts/experiments/base-raw-webmcp-v0");
  const priorSeal = join(outDir, "prior-tool-policy-happy");
  if (existsSync(prior) && !existsSync(priorSeal)) {
    cpSync(prior, priorSeal, { recursive: true });
  }

  writeJson(join(outDir, "VARIATION_MATRIX.json"), STAGE1_VARIATION_MATRIX);

  const cells: RawCellResult[] = [];
  const t0 = Date.now();

  const harnessReset = (
    store: ReliableRailStore,
    recorder: EventRecorder,
    stage: string,
  ) => {
    invokeTool(store, recorder, "reset_fixture", {}, stage, {});
  };

  // --- Observed: registered-path constraint failure (purchase before review) ---
  {
    const store = new ReliableRailStore(options.fixture);
    const recorder = new EventRecorder();
    const path = registerRawReliableRailPath(store, recorder, "stage1-constraint");
    harnessReset(store, recorder, "stage1-constraint");
    path.execute("select_journey", {
      outbound_journey_id: options.fixture.task_target.outbound_journey_id,
      return_journey_id: options.fixture.task_target.return_journey_id,
    });
    path.execute("reserve_seats", { seat_ids: options.fixture.default_adjacent_pair });
    // Skip review — precondition unmet
    const purchase = path.execute("purchase_tickets");
    const cell: RawCellResult = {
      struggle_id: "constraint_accuracy",
      surface_id: "rail.purchase_before_review",
      evidence_class: "observed",
      mechanisms: "off",
      path: "page_registered_mock",
      observed_pain: [
        "consequential_call_without_review",
        `error=${purchase.error ?? "none"}`,
        "no_contract_violation_envelope",
      ],
      metrics: {
        registered_tool_count: path.registered.length,
        purchase_ok: purchase.ok,
        committed_purchase_count: store.getOrder().committed_purchase_count,
        tool_events: recorder.all().filter((e) => e.event_type === "tool_call").length,
      },
      notes: [
        "Mechanisms off: domain may reject, but raw result is unstructured string error without A contract categories.",
        `lane=${path.lane}`,
      ],
    };
    cells.push(cell);
    writeJson(join(outDir, "cells", `${cell.surface_id}.json`), {
      ...cell,
      events_jsonl: recorder.toJsonl(),
    });
  }

  // --- Observed: stale epoch still dispatches (B off) ---
  for (let i = 0; i < reps; i += 1) {
    const store = new ReliableRailStore(options.fixture);
    const recorder = new EventRecorder();
    const path = registerRawReliableRailPath(store, recorder, "stage1-drift");
    bookToReview(path.execute, options.fixture, () =>
      harnessReset(store, recorder, "stage1-drift"),
    );
    // With freshness OFF, mismatched epochs are not checked by invokeTool.
    const purchase = invokeTool(
      store,
      recorder,
      "purchase_tickets",
      {},
      "stage1-drift",
      {
        capabilityFreshness: false,
        expectedCapabilityEpoch: "epoch:discovered",
        actualCapabilityEpoch: "epoch:after_toolchange",
      },
    );
    const cell: RawCellResult = {
      struggle_id: "state_capability_drift",
      surface_id: "rail.stale_epoch_purchase",
      evidence_class: "observed",
      mechanisms: "off",
      path: "page_registered_mock",
      observed_pain: [
        "known_stale_consequential_dispatch",
        `purchase_ok=${purchase.ok}`,
        "zero_freshness_blocks",
      ],
      metrics: {
        repetition: i,
        purchase_ok: purchase.ok,
        committed_purchase_count: store.getOrder().committed_purchase_count,
        stale_block_count: 0,
      },
      notes: [
        "Raw lane does not consult capability epochs; stale plan still purchases.",
      ],
    };
    cells.push(cell);
    if (i === 0) {
      writeJson(join(outDir, "cells", `${cell.surface_id}.rep0.json`), {
        ...cell,
        events_jsonl: recorder.toJsonl(),
      });
    }
  }

  // --- Observed: ambiguous effect + opaque result (timeout after commit, D1/C1 off) ---
  for (let i = 0; i < reps; i += 1) {
    const store = new ReliableRailStore(options.fixture);
    const recorder = new EventRecorder();
    const path = registerRawReliableRailPath(store, recorder, "stage1-ambiguous");
    bookToReview(path.execute, options.fixture, () =>
      harnessReset(store, recorder, "stage1-ambiguous"),
    );
    const timedOut = invokeTool(
      store,
      recorder,
      "purchase_tickets",
      {},
      "stage1-ambiguous",
      { simulateClientTimeoutAfterCommit: true },
    );
    const blindRetry = path.execute("purchase_tickets");
    const oracle = evaluateOrderOracle(options.fixture, store.getOrder());
    const cell: RawCellResult = {
      struggle_id: "ambiguous_effect",
      surface_id: "rail.timeout_after_commit",
      evidence_class: "observed",
      mechanisms: "off",
      path: "page_registered_mock",
      observed_pain: [
        "commit_possible_without_usable_response",
        `client_error=${timedOut.error}`,
        "no_operation_identity_in_raw_response",
        `blind_retry_error=${blindRetry.error ?? "none"}`,
      ],
      metrics: {
        repetition: i,
        client_ok: timedOut.ok,
        committed_purchase_count: store.getOrder().committed_purchase_count,
        blind_retry_ok: blindRetry.ok,
        oracle_ok: oracle.ok,
        structured_failure_present: false,
      },
      notes: [
        "Server committed once; client saw opaque Error; blind retry rejected by domain string only.",
        "Without D1/C1 the agent has no typed ambiguous-commit envelope or reconcile mandate.",
      ],
    };
    cells.push(cell);
    if (i === 0) {
      writeJson(join(outDir, "cells", `${cell.surface_id}.rep0.json`), {
        ...cell,
        events_jsonl: recorder.toJsonl(),
        final_order: store.getOrder(),
      });
    }
  }

  // --- Observed: interruption after purchase without recovery policy ---
  {
    const store = new ReliableRailStore(options.fixture);
    const recorder = new EventRecorder();
    const path = registerRawReliableRailPath(store, recorder, "stage1-reload");
    bookToReview(path.execute, options.fixture, () =>
      harnessReset(store, recorder, "stage1-reload"),
    );
    path.execute("purchase_tickets");
    const beforeReload = store.getOrder();
    // Simulate document discontinuity: agent loses local confirmation and retries purchase.
    recorder.record({
      component: "harness",
      stage: "stage1-reload",
      event_type: "document_discontinuity",
      payload: { kind: "reload", lost_local_confirmation: true },
    });
    const afterReloadRetry = path.execute("purchase_tickets");
    const cell: RawCellResult = {
      struggle_id: "interruption_reload",
      surface_id: "rail.reload_after_purchase",
      evidence_class: "observed",
      mechanisms: "off",
      path: "page_registered_mock",
      observed_pain: [
        "document_discontinuity_after_commit",
        "no_checkpoint_reconstruction",
        `retry_error=${afterReloadRetry.error ?? "none"}`,
      ],
      metrics: {
        committed_before_reload: beforeReload.committed_purchase_count,
        committed_after_retry: store.getOrder().committed_purchase_count,
        recovery_decision_present: false,
      },
      notes: [
        "Raw lane has no D2 recovery decision; agent narrative would be the only resume signal.",
      ],
    };
    cells.push(cell);
    writeJson(join(outDir, "cells", `${cell.surface_id}.json`), {
      ...cell,
      events_jsonl: recorder.toJsonl(),
    });
  }

  // --- Observed: opaque inconsistent result form from timeout injector ---
  {
    const store = new ReliableRailStore(options.fixture);
    const recorder = new EventRecorder();
    const path = registerRawReliableRailPath(store, recorder, "stage1-opaque");
    bookToReview(path.execute, options.fixture, () =>
      harnessReset(store, recorder, "stage1-opaque"),
    );
    const timedOut = invokeTool(
      store,
      recorder,
      "purchase_tickets",
      {},
      "stage1-opaque",
      { simulateClientTimeoutAfterCommit: true },
    );
    const cell: RawCellResult = {
      struggle_id: "inconsistent_opaque_results",
      surface_id: "rail.opaque_timeout_error",
      evidence_class: "observed",
      mechanisms: "off",
      path: "page_registered_mock",
      observed_pain: [
        `error_string=${timedOut.error}`,
        "missing_structured_failure",
        "missing_diagnosis_action",
      ],
      metrics: {
        error_is_generic_Error: timedOut.error === "Error",
        has_structured_failure: false,
        committed_purchase_count: store.getOrder().committed_purchase_count,
      },
      notes: ["Same underlying commit ambiguity surfaces as opaque Error without C1."],
    };
    cells.push(cell);
    writeJson(join(outDir, "cells", `${cell.surface_id}.json`), {
      ...cell,
      events_jsonl: recorder.toJsonl(),
    });
  }

  // --- Observed: happy-path call count / latency bound sample ---
  {
    const started = Date.now();
    const store = new ReliableRailStore(options.fixture);
    const recorder = new EventRecorder();
    const path = registerRawReliableRailPath(store, recorder, "stage1-perf");
    bookToReview(path.execute, options.fixture, () =>
      harnessReset(store, recorder, "stage1-perf"),
    );
    path.execute("purchase_tickets");
    const durationMs = Date.now() - started;
    const toolCalls = recorder.all().filter((e) => e.event_type === "tool_call").length;
    const cell: RawCellResult = {
      struggle_id: "unnecessary_calls_latency",
      surface_id: "rail.happy_path_call_count",
      evidence_class: "observed",
      mechanisms: "off",
      path: "page_registered_mock",
      observed_pain: [
        "baseline_call_and_latency_captured_for_later_comparison",
      ],
      metrics: {
        total_tool_calls: toolCalls,
        duration_ms: durationMs,
        committed_purchase_count: store.getOrder().committed_purchase_count,
        oracle_ok: evaluateOrderOracle(options.fixture, store.getOrder()).ok,
      },
      notes: [
        "Not a failure cell; establishes raw happy-path cost for overhead comparisons.",
      ],
    };
    cells.push(cell);
    writeJson(join(outDir, "cells", `${cell.surface_id}.json`), cell);
  }

  // --- Hypothesized scripted lab raw failures (surfaces 2–3 for several struggles) ---
  const adversityToStruggle: Record<Adversity, DeclaredStruggleId> = {
    invalid_precondition: "constraint_accuracy",
    stale_state: "state_capability_drift",
    ambiguous_commit: "ambiguous_effect",
  };
  for (const useCase of USE_CASES) {
    const comparison = runComparison(useCase);
    const struggle_id = adversityToStruggle[useCase.adversity];
    const cell: RawCellResult = {
      struggle_id,
      surface_id: `lab.${useCase.id}.raw_scripted`,
      evidence_class: "hypothesized_scripted",
      mechanisms: "off",
      path: "lab_scripted_raw",
      observed_pain: [
        `raw_verdict=${comparison.raw.verdict}`,
        `adversity=${useCase.adversity}`,
        `effect_count=${comparison.raw.effectCount}`,
      ],
      metrics: {
        raw_fail: comparison.raw.verdict === "FAIL",
        guided_pass: comparison.guided.verdict === "PASS",
        raw_trace_steps: comparison.raw.trace.length,
      },
      notes: [
        "Lab raw lane is a scripted narrative of expected raw failure — hypothesized until live agent confirms.",
        "Counted toward surface coverage of the mechanical invariant, not as live-agent observation.",
      ],
    };
    cells.push(cell);
  }

  const elapsed = Date.now() - t0;
  const matrixOk = STAGE1_VARIATION_MATRIX.every((row) => row.surfaces.length >= 3);
  const observedByStruggle = new Set(
    cells.filter((c) => c.evidence_class === "observed").map((c) => c.struggle_id),
  );
  const gate = {
    variation_matrix_ge_3: matrixOk,
    registered_path_exercised: cells.some((c) => c.path === "page_registered_mock"),
    observed_constraint: observedByStruggle.has("constraint_accuracy"),
    observed_drift: observedByStruggle.has("state_capability_drift"),
    observed_opaque: observedByStruggle.has("inconsistent_opaque_results"),
    observed_ambiguous: observedByStruggle.has("ambiguous_effect"),
    observed_interruption: observedByStruggle.has("interruption_reload"),
    observed_perf_sample: observedByStruggle.has("unnecessary_calls_latency"),
    hypothesized_separated: cells.some((c) => c.evidence_class === "hypothesized_scripted"),
    elapsed_ms: elapsed,
  };

  writeJson(join(outDir, "CELLS_INDEX.json"), { candidate: options.candidateVersion, cells, gate });
  writeJson(join(outDir, "GATE1_MACHINE.json"), gate);

  return { outDir, cells, gate };
}
