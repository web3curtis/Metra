import type { ReliableRailStore } from "./store.ts";
import type { ToolResult } from "./types.ts";
import { validateCall, validateOutput } from "../../../reliability-boundary/contract/contractV0.ts";
import { rejectStaleConsequential } from "../../../reliability-boundary/freshness/capabilityFreshness.ts";
import {
  envelopeFromToolError,
  type StructuredFailure,
} from "../../../reliability-boundary/semantics/structuredFailure.ts";
import { selectDiagnosisAction } from "../../../reliability-boundary/diagnosis/diagnosisPolicy.ts";
import {
  beginEffect,
  markCommitted,
  markUnknown,
  newOperationId,
  reconcileAmbiguousCommit,
  rejectDuplicateOperation,
  type EffectRecord,
} from "../../../reliability-boundary/effect/effectSafety.ts";
import type { ProtocolRunContext } from "../../../reliability-boundary/spine/protocolSpine.ts";

export type RuntimeEvent = {
  sequence: number;
  timestamp: string;
  component: "agent" | "webmcp" | "app" | "harness" | "evaluator";
  stage: string;
  event_type: string;
  payload: Record<string, unknown>;
};

export class EventRecorder {
  private events: RuntimeEvent[] = [];
  private sequence = 0;

  reset(): void {
    this.events = [];
    this.sequence = 0;
  }

  record(
    partial: Omit<RuntimeEvent, "sequence" | "timestamp"> & {
      timestamp?: string;
    },
  ): RuntimeEvent {
    this.sequence += 1;
    const event: RuntimeEvent = {
      sequence: this.sequence,
      timestamp: partial.timestamp ?? new Date().toISOString(),
      component: partial.component,
      stage: partial.stage,
      event_type: partial.event_type,
      payload: partial.payload,
    };
    this.events.push(event);
    return event;
  }

  all(): RuntimeEvent[] {
    return [...this.events];
  }

  toJsonl(): string {
    return this.events.map((e) => JSON.stringify(e)).join("\n") + (this.events.length ? "\n" : "");
  }
}

export type ToolName =
  | "search_journeys"
  | "select_journey"
  | "list_available_seats"
  | "reserve_seats"
  | "review_order"
  | "purchase_tickets"
  | "get_order"
  | "cancel_draft"
  | "reset_fixture";

export function invokeTool(
  store: ReliableRailStore,
  recorder: EventRecorder,
  name: ToolName,
  input: Record<string, unknown> = {},
  stage = "calibration",
  options: {
    contractConformance?: boolean;
    capabilityFreshness?: boolean;
    structuredSemantics?: boolean;
    diagnosisPolicy?: boolean;
    effectSafety?: boolean;
    effectRegistry?: Map<string, EffectRecord>;
    /** Shared spine context — when set, C2/D2 decisions block consequential dispatch. */
    protocol?: ProtocolRunContext;
    /** Adversity: timeout after may-have-committed without local confirm */
    simulatePurchaseTimeoutUnknown?: boolean;
    /** Adversity: server committed but client only sees timeout */
    simulateClientTimeoutAfterCommit?: boolean;
    /** Adversity: identical opaque error before domain (fair control/treatment) */
    injectOpaqueError?: string;
    expectedCapabilityEpoch?: string;
    actualCapabilityEpoch?: string;
  } = {},
): ToolResult {
  const READ_ONLY = new Set<ToolName>([
    "search_journeys",
    "list_available_seats",
    "review_order",
    "get_order",
    "reset_fixture",
  ]);
  const protocol = options.protocol;
  if (protocol) {
    const gate = protocol.assertDispatchAllowed({
      tool: name,
      readOnly: READ_ONLY.has(name),
      isReconcileTool: name === "get_order",
    });
    if (!gate.ok) {
      recorder.record({
        component: "harness",
        stage,
        event_type: "decision_block",
        payload: { tool: name, code: gate.code, action: gate.action },
      });
      return {
        ok: false,
        error: gate.code,
        data: { decision_action: gate.action, tool: name },
      };
    }
  }

  const finish = (result: ToolResult, extraPayload: Record<string, unknown> = {}): ToolResult => {
    let out = result;
    if (options.structuredSemantics && !out.ok && out.error) {
      const order = store.getOrder();
      const envelope = envelopeFromToolError({
        tool: name,
        error: out.error,
        state: order.state,
        state_revision: order.state_revision,
      });
      let data: Record<string, unknown> = {
        ...(typeof out.data === "object" && out.data !== null
          ? (out.data as Record<string, unknown>)
          : {}),
        structured_failure: envelope,
      };
      if (options.diagnosisPolicy) {
        const decision = selectDiagnosisAction({
          structuredFailure: envelope as StructuredFailure,
        });
        data = { ...data, diagnosis_action: decision };
        protocol?.setDecision({
          action:
            decision.action === "retry_safe"
              ? "retry_safe"
              : decision.action === "reobserve"
                ? "reobserve"
                : decision.action === "reconcile"
                  ? "reconcile"
                  : decision.action === "recover"
                    ? "recover"
                    : decision.action === "continue"
                      ? "continue"
                      : decision.action === "stop"
                        ? "stop"
                        : "escalate",
          reason_code: envelope.category,
          evidence_refs: decision.evidence,
        });
      }
      out = { ...out, data };
    }
    if (out.ok && protocol) {
      if (READ_ONLY.has(name) && name !== "get_order") protocol.noteSuccessfulObserve();
      if (name === "get_order") protocol.noteSuccessfulReconcile();
    }
    const structuredFailure =
      options.structuredSemantics && out.data && typeof out.data === "object"
        ? (out.data as { structured_failure?: unknown }).structured_failure ?? null
        : null;
    const diagnosisAction =
      options.diagnosisPolicy && out.data && typeof out.data === "object"
        ? (out.data as { diagnosis_action?: unknown }).diagnosis_action ?? null
        : null;
    recorder.record({
      component: "webmcp",
      stage,
      event_type: "tool_result",
      payload: {
        tool: name,
        ok: out.ok,
        error: out.error ?? null,
        state: store.getOrder().state,
        state_revision: store.getOrder().state_revision,
        structured_failure: structuredFailure,
        diagnosis_action: diagnosisAction,
        ...extraPayload,
      },
    });
    return out;
  };

  recorder.record({
    component: "webmcp",
    stage,
    event_type: "tool_call",
    payload: { tool: name, input },
  });

  if (options.capabilityFreshness) {
    const fresh = rejectStaleConsequential(
      name,
      options.expectedCapabilityEpoch,
      options.actualCapabilityEpoch,
    );
    if (!fresh.ok) {
      return finish(
        {
          ok: false,
          error: fresh.code ?? "stale_capability_epoch",
          data: fresh,
        },
        { freshness: true },
      );
    }
  }

  if (options.contractConformance) {
    const fixture = store.getFixture();
    const gate = validateCall({
      tool: name,
      args: input,
      state: store.getOrder().state,
      currency: fixture.currency,
      budget_aud: fixture.budget_aud,
      passenger_count: fixture.passenger_count,
    });
    if (!gate.ok) {
      return finish(
        {
          ok: false,
          error: "contract_violation",
          data: { violations: gate.violations },
        },
        { contract: true },
      );
    }
  }

  // Shared adversity: opaque failure identical for raw and treatment (before domain)
  if (options.injectOpaqueError && name === "purchase_tickets") {
    return finish(
      {
        ok: false,
        error: options.injectOpaqueError,
        data: { adversity: "opaque_failure" },
      },
      { adversity: "opaque_failure" },
    );
  }

  let result: ToolResult;
  switch (name) {
    case "search_journeys":
      result = store.searchJourneys({
        origin: input.origin as string | undefined,
        destination: input.destination as string | undefined,
        direction: input.direction as "outbound" | "return" | undefined,
      });
      break;
    case "select_journey":
      result = store.selectJourney({
        outbound_journey_id: String(input.outbound_journey_id ?? ""),
        return_journey_id: String(input.return_journey_id ?? ""),
      });
      break;
    case "list_available_seats":
      result = store.listAvailableSeats();
      break;
    case "reserve_seats":
      result = store.reserveSeats({
        seat_ids: (input.seat_ids as string[]) ?? [],
      });
      break;
    case "review_order":
      result = store.reviewOrder();
      break;
    case "purchase_tickets": {
      if (options.effectSafety) {
        const registry = options.effectRegistry ?? new Map<string, EffectRecord>();
        const operationId =
          typeof input.operation_id === "string" && input.operation_id.length > 0
            ? input.operation_id
            : newOperationId("purchase");
        const orderBefore = store.getOrder();
        const dup = rejectDuplicateOperation({
          incoming_operation_id: operationId,
          committed_operation_ids: [...registry.values()]
            .filter((r) => r.phase === "committed")
            .map((r) => r.operation_id),
          committed_purchase_count: orderBefore.committed_purchase_count,
        });
        if (!dup.ok) {
          result = {
            ok: false,
            error: dup.code ?? "duplicate_purchase_rejected",
            data: { operation_id: operationId, order: orderBefore },
          };
          break;
        }
        let record = beginEffect({
          operation_id: operationId,
          tool: "purchase_tickets",
          state_revision_before: orderBefore.state_revision,
        });
        if (options.simulatePurchaseTimeoutUnknown) {
          record = markUnknown(record);
          registry.set(operationId, record);
          result = {
            ok: false,
            error: "purchase_timeout_unknown",
            data: {
              operation_id: operationId,
              effect: record,
              note: "Ambiguous commit — reconcile via get_order before retry",
            },
          };
          break;
        }
        if (options.simulateClientTimeoutAfterCommit) {
          const committed = store.purchaseTickets();
          if (committed.ok && committed.data && typeof committed.data === "object") {
            const data = committed.data as { order_id?: string; receipt_id?: string };
            record = {
              ...markCommitted(
                record,
                String(data.order_id ?? ""),
                String(data.receipt_id ?? ""),
              ),
              phase: "unknown",
            };
            registry.set(operationId, record);
            result = {
              ok: false,
              error: "purchase_timeout_unknown",
              data: {
                operation_id: operationId,
                effect: record,
                note: "Client timeout after possible commit — reconcile before retry",
              },
            };
          } else {
            registry.set(operationId, record);
            result = committed;
          }
          break;
        }
        result = store.purchaseTickets();
        if (result.ok && result.data && typeof result.data === "object") {
          const data = result.data as { order_id?: string; receipt_id?: string };
          record = markCommitted(
            record,
            String(data.order_id ?? ""),
            String(data.receipt_id ?? ""),
          );
          registry.set(operationId, record);
          result = {
            ...result,
            data: { ...data, operation_id: operationId, effect: record },
          };
        } else {
          registry.set(operationId, record);
          result = {
            ...result,
            data: {
              ...(typeof result.data === "object" && result.data !== null
                ? (result.data as Record<string, unknown>)
                : {}),
              operation_id: operationId,
              effect: record,
            },
          };
        }
      } else if (options.simulateClientTimeoutAfterCommit) {
        // Apparatus-only raw-lane injector: commit may occur while the client
        // only sees an opaque timeout/Error (mechanisms A–D2 remain off).
        const committed = store.purchaseTickets();
        if (committed.ok) {
          result = {
            ok: false,
            error: "Error",
            data: {
              note: "raw_client_timeout_after_possible_commit",
              authority: "unavailable",
              commit_status: "possible",
            },
          };
        } else {
          result = committed;
        }
      } else {
        result = store.purchaseTickets();
      }
      break;
    }
    case "get_order":
      result = store.getOrderTool();
      if (options.effectSafety && typeof input.operation_id === "string") {
        const registry = options.effectRegistry ?? new Map<string, EffectRecord>();
        const prior = registry.get(input.operation_id) ?? null;
        const observed = store.getOrder();
        const reconciliation = reconcileAmbiguousCommit({
          operation_id: input.operation_id,
          observed: {
            state: observed.state,
            order_id: observed.order_id,
            receipt_id: observed.receipt_id,
            committed_purchase_count: observed.committed_purchase_count,
          },
          prior,
        });
        result = {
          ok: true,
          data: { order: observed, reconciliation },
        };
      }
      break;
    case "cancel_draft":
      result = store.cancelDraft();
      break;
    case "reset_fixture":
      result = { ok: true, data: store.reset() };
      break;
    default: {
      const _exhaustive: never = name;
      result = { ok: false, error: `unknown_tool:${String(_exhaustive)}` };
    }
  }

  if (options.contractConformance) {
    const orderAfter = store.getOrder();
    const outGate = validateOutput({
      tool: name,
      ok: result.ok,
      data: result.data,
      state_after: orderAfter.state,
    });
    if (!outGate.ok) {
      result = {
        ok: false,
        error: "contract_output_violation",
        data: { violations: outGate.violations, prior: result.data },
      };
    }
  }

  return finish(result);
}

export function runScriptedHappyPath(
  store: ReliableRailStore,
  recorder: EventRecorder,
  stage = "calibration",
): { purchase: ToolResult; duplicate: ToolResult } {
  const fixture = store.getFixture();
  invokeTool(store, recorder, "reset_fixture", {}, stage);
  invokeTool(
    store,
    recorder,
    "search_journeys",
    { origin: fixture.origin, destination: fixture.destination },
    stage,
  );
  invokeTool(
    store,
    recorder,
    "select_journey",
    {
      outbound_journey_id: fixture.task_target.outbound_journey_id,
      return_journey_id: fixture.task_target.return_journey_id,
    },
    stage,
  );
  invokeTool(
    store,
    recorder,
    "reserve_seats",
    { seat_ids: fixture.default_adjacent_pair },
    stage,
  );
  invokeTool(store, recorder, "review_order", {}, stage);
  const purchase = invokeTool(store, recorder, "purchase_tickets", {}, stage);
  const duplicate = invokeTool(store, recorder, "purchase_tickets", {}, stage);
  return { purchase, duplicate };
}
