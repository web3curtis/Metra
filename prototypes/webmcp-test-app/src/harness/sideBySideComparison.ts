/**
 * Live side-by-side raw vs prototype train-ticket comparison (deterministic).
 * Identical adversity receipts — judge can monitor both arms in real time.
 */

import { EventRecorder, invokeTool } from "../domain/harness.ts";
import { ReliableRailStore } from "../domain/store.ts";
import { evaluateOrderOracle } from "../domain/oracle.ts";
import type { Fixture, ToolResult } from "../domain/types.ts";
import type { EffectRecord } from "../../../reliability-boundary/effect/effectSafety.ts";
import { newOperationId } from "../../../reliability-boundary/effect/effectSafety.ts";
import { decideRecovery } from "../../../reliability-boundary/recovery/stateRecovery.ts";
import {
  assertMatchedAdversity,
  createAdversityReceipt,
  exactStageFlags,
  type AdversityId,
  type AdversityReceipt,
} from "../adversity/adversityEngine.ts";

export type ArmId = "raw" | "prototype";

export type ArmTraceEvent = {
  seq: number;
  arm: ArmId;
  tool: string;
  ok: boolean;
  error?: string;
  note?: string;
};

export type ArmResult = {
  arm: ArmId;
  adversity_receipt: AdversityReceipt;
  order_state: string;
  committed_purchase_count: number;
  oracle_ok: boolean;
  oracle_reasons: string[];
  total_tool_calls: number;
  operation_id: string | null;
  last_error: string | null;
  structured_failure: unknown;
  diagnosis_action: unknown;
  recovery_action: string | null;
  trace: ArmTraceEvent[];
};

export type SideBySideResult = {
  comparison_valid: boolean;
  invalid_reason?: string;
  adversity: AdversityId;
  raw: ArmResult;
  prototype: ArmResult;
  improvement: "prototype_better" | "raw_better" | "equal" | "inconclusive";
  summary: string;
};

function prepToReviewed(
  store: ReliableRailStore,
  rec: EventRecorder,
  fixture: Fixture,
  stage: string,
  opts: Parameters<typeof invokeTool>[5],
): void {
  invokeTool(store, rec, "reset_fixture", {}, stage, opts);
  invokeTool(
    store,
    rec,
    "select_journey",
    {
      outbound_journey_id: fixture.task_target.outbound_journey_id,
      return_journey_id: fixture.task_target.return_journey_id,
    },
    stage,
    opts,
  );
  invokeTool(
    store,
    rec,
    "reserve_seats",
    { seat_ids: fixture.default_adjacent_pair },
    stage,
    opts,
  );
  invokeTool(store, rec, "review_order", {}, stage, opts);
}

function runArm(input: {
  arm: ArmId;
  fixture: Fixture;
  adversity: AdversityId;
  receipt: AdversityReceipt;
}): ArmResult {
  const store = new ReliableRailStore(input.fixture);
  const rec = new EventRecorder();
  const registry = new Map<string, EffectRecord>();
  const prototype = input.arm === "prototype";
  const flags = prototype ? exactStageFlags("full") : exactStageFlags("off");
  const epochActual =
    input.adversity === "capability_change"
      ? (input.receipt.payload.new_epoch ?? "epoch:changed")
      : "epoch:ui";

  const baseOpts = {
    contractConformance: flags.contract_conformance,
    capabilityFreshness: flags.capability_freshness,
    structuredSemantics: flags.structured_semantics,
    diagnosisPolicy: flags.diagnosis_policy,
    effectSafety: flags.effect_safety,
    effectRegistry: registry,
    expectedCapabilityEpoch: "epoch:ui" as string,
    actualCapabilityEpoch: epochActual,
  };

  const trace: ArmTraceEvent[] = [];
  let seq = 0;
  const pushTrace = (tool: string, result: ToolResult, note?: string) => {
    seq += 1;
    trace.push({
      seq,
      arm: input.arm,
      tool,
      ok: result.ok,
      error: result.error,
      note,
    });
  };

  if (input.adversity === "contract_ambiguity") {
    const early = invokeTool(store, rec, "purchase_tickets", {}, `${input.arm}-early`, baseOpts);
    pushTrace("purchase_tickets", early, "early_invalid");
    return finishArm(input, store, rec, null, early, trace, null);
  }

  prepToReviewed(store, rec, input.fixture, `${input.arm}-prep`, baseOpts);
  const opId = prototype ? newOperationId("side") : null;
  const timeout = input.adversity === "client_timeout_after_commit";
  const opaque = input.adversity === "opaque_failure";
  let recovery_action: string | null = null;

  if (input.adversity === "capability_change") {
    const stale = invokeTool(
      store,
      rec,
      "purchase_tickets",
      opId ? { operation_id: opId } : {},
      `${input.arm}-stale`,
      baseOpts,
    );
    pushTrace("purchase_tickets", stale, "stale_attempt");
    if (prototype && !stale.ok) {
      const ok = invokeTool(
        store,
        rec,
        "purchase_tickets",
        { operation_id: opId ?? newOperationId("side") },
        `${input.arm}-refresh`,
        {
          ...baseOpts,
          expectedCapabilityEpoch: epochActual,
          actualCapabilityEpoch: epochActual,
        },
      );
      pushTrace("purchase_tickets", ok, "after_reobserve");
    } else if (!prototype) {
      const retry = invokeTool(store, rec, "purchase_tickets", {}, `${input.arm}-blind`, {});
      pushTrace("purchase_tickets", retry, "blind_retry");
    }
  } else if (input.adversity === "reload_after_purchase") {
    const purchase = invokeTool(
      store,
      rec,
      "purchase_tickets",
      opId ? { operation_id: opId } : {},
      `${input.arm}-buy`,
      baseOpts,
    );
    pushTrace("purchase_tickets", purchase, "pre_reload");
    if (store.getOrder().state === "PURCHASED") {
      const snap = store.getOrder();
      const reloaded = new ReliableRailStore(input.fixture);
      reloaded.hydrateOrder(snap);
      if (prototype) {
        const decision = decideRecovery({
          tools_include_purchase: true,
          order_state: reloaded.getOrder().state,
          order_id: reloaded.getOrder().order_id,
          receipt_id: reloaded.getOrder().receipt_id,
          total_aud: reloaded.getOrder().total_aud,
          budget_aud: input.fixture.budget_aud,
          seat_ids: reloaded.getOrder().seat_ids,
          price_drift: false,
          seat_drift: false,
        });
        recovery_action = decision.action;
        const blocked = invokeTool(
          reloaded,
          rec,
          "purchase_tickets",
          {},
          `${input.arm}-post-reload`,
          { ...baseOpts, contractConformance: true },
        );
        pushTrace("purchase_tickets", blocked, `recovery_${decision.action}`);
        store.hydrateOrder(reloaded.getOrder());
      } else {
        const lost = new ReliableRailStore(input.fixture);
        const again = invokeTool(lost, rec, "purchase_tickets", {}, `${input.arm}-lost`, {});
        pushTrace("purchase_tickets", again, "raw_empty_after_reload_model");
        store.hydrateOrder(snap);
      }
    }
  } else {
    const purchase = invokeTool(
      store,
      rec,
      "purchase_tickets",
      opId ? { operation_id: opId } : {},
      `${input.arm}-buy`,
      {
        ...baseOpts,
        simulateClientTimeoutAfterCommit: timeout,
        injectOpaqueError: opaque
          ? (input.receipt.payload.opaque_error ?? "opaque_provider_failure")
          : undefined,
      },
    );
    pushTrace(
      "purchase_tickets",
      purchase,
      timeout ? "timeout_path" : opaque ? "opaque" : "purchase",
    );

    if (prototype && timeout && !purchase.ok && opId) {
      const got = invokeTool(
        store,
        rec,
        "get_order",
        { operation_id: opId },
        `${input.arm}-recon`,
        baseOpts,
      );
      pushTrace("get_order", got, "reconcile");
    } else if (!prototype && timeout && !purchase.ok) {
      const retry = invokeTool(store, rec, "purchase_tickets", {}, `${input.arm}-retry`, {});
      pushTrace("purchase_tickets", retry, "raw_retry_after_timeout");
    }
  }

  return finishArm(input, store, rec, opId, null, trace, recovery_action);
}

function finishArm(
  input: { arm: ArmId; receipt: AdversityReceipt; fixture: Fixture },
  store: ReliableRailStore,
  rec: EventRecorder,
  opId: string | null,
  early: ToolResult | null,
  trace: ArmTraceEvent[],
  recovery_action: string | null,
): ArmResult {
  const order = store.getOrder();
  const oracle = evaluateOrderOracle(input.fixture, order);
  const lastFail = [...trace].reverse().find((t) => !t.ok);
  const toolResults = rec.all().filter((e) => e.event_type === "tool_result");
  const lastWithDiag = [...toolResults].reverse().find((e) => {
    const p = e.payload as { structured_failure?: unknown; diagnosis_action?: unknown };
    return p.structured_failure != null || p.diagnosis_action != null;
  });
  const fromEarly = (early?.data ?? {}) as {
    structured_failure?: unknown;
    diagnosis_action?: unknown;
  };
  const payload = (lastWithDiag?.payload ?? fromEarly) as {
    structured_failure?: unknown;
    diagnosis_action?: unknown;
  };

  return {
    arm: input.arm,
    adversity_receipt: input.receipt,
    order_state: order.state,
    committed_purchase_count: order.committed_purchase_count,
    oracle_ok: oracle.ok,
    oracle_reasons: oracle.reasons,
    total_tool_calls: rec.all().filter((e) => e.event_type === "tool_call").length,
    operation_id: opId,
    last_error: early?.error ?? lastFail?.error ?? null,
    structured_failure: payload.structured_failure ?? fromEarly.structured_failure ?? null,
    diagnosis_action: payload.diagnosis_action ?? fromEarly.diagnosis_action ?? null,
    recovery_action,
    trace,
  };
}

function scoreImprovement(
  raw: ArmResult,
  proto: ArmResult,
  adversity: AdversityId,
): { kind: SideBySideResult["improvement"]; summary: string } {
  if (adversity === "none") {
    if (
      raw.oracle_ok &&
      proto.oracle_ok &&
      raw.committed_purchase_count === 1 &&
      proto.committed_purchase_count === 1
    ) {
      return {
        kind: "equal",
        summary: "Happy path equal — not an improvement claim (expected).",
      };
    }
  }
  if (adversity === "contract_ambiguity" || adversity === "opaque_failure") {
    if (
      raw.committed_purchase_count === 0 &&
      proto.committed_purchase_count === 0 &&
      (proto.structured_failure != null || proto.diagnosis_action != null)
    ) {
      return {
        kind: "prototype_better",
        summary: "Both safe (0 commits); prototype adds structured diagnosis.",
      };
    }
  }
  if (adversity === "client_timeout_after_commit" || adversity === "capability_change") {
    if (proto.committed_purchase_count === 1 && raw.committed_purchase_count !== 1) {
      return {
        kind: "prototype_better",
        summary: "Prototype ends at exactly one commit; raw does not.",
      };
    }
    if (
      proto.committed_purchase_count === 1 &&
      raw.committed_purchase_count === 1 &&
      proto.trace.some((t) => t.note === "reconcile" || t.note === "after_reobserve")
    ) {
      return {
        kind: "prototype_better",
        summary: "Both one commit; prototype used reconcile/reobserve path.",
      };
    }
    if (raw.committed_purchase_count > 1 && proto.committed_purchase_count <= 1) {
      return {
        kind: "prototype_better",
        summary: "Prototype prevented duplicate commit risk.",
      };
    }
  }
  if (adversity === "reload_after_purchase") {
    if (proto.recovery_action === "stop" && proto.committed_purchase_count === 1) {
      return {
        kind: "prototype_better",
        summary: "Prototype rehydrated and enforced stop after reload simulation.",
      };
    }
  }
  if (proto.oracle_ok && !raw.oracle_ok) {
    return { kind: "prototype_better", summary: "Prototype oracle success; raw failed." };
  }
  if (!proto.oracle_ok && raw.oracle_ok) {
    return { kind: "raw_better", summary: "Raw succeeded; prototype did not — claim challenged." };
  }
  return { kind: "inconclusive", summary: "No clear improvement under this adversity." };
}

export function runSideBySideComparison(input: {
  fixture: Fixture;
  adversity: AdversityId;
}): SideBySideResult {
  const seed = `live-sidebyside-${input.adversity}-${Date.now()}`;
  const rawReceipt = createAdversityReceipt({
    adversity_id: input.adversity,
    arm: "control",
    payload: { seed },
  });
  const protoReceipt = createAdversityReceipt({
    adversity_id: input.adversity,
    arm: "treatment",
    payload: { seed },
  });
  const match = assertMatchedAdversity(rawReceipt, protoReceipt);
  if (!match.ok) {
    const empty = (arm: ArmId, receipt: AdversityReceipt): ArmResult => ({
      arm,
      adversity_receipt: receipt,
      order_state: "EMPTY",
      committed_purchase_count: 0,
      oracle_ok: false,
      oracle_reasons: ["comparison_invalid"],
      total_tool_calls: 0,
      operation_id: null,
      last_error: match.reason,
      structured_failure: null,
      diagnosis_action: null,
      recovery_action: null,
      trace: [],
    });
    return {
      comparison_valid: false,
      invalid_reason: match.reason,
      adversity: input.adversity,
      raw: empty("raw", rawReceipt),
      prototype: empty("prototype", protoReceipt),
      improvement: "inconclusive",
      summary: "Invalid comparison — adversity receipts differ",
    };
  }

  const raw = runArm({
    arm: "raw",
    fixture: input.fixture,
    adversity: input.adversity,
    receipt: rawReceipt,
  });
  const prototype = runArm({
    arm: "prototype",
    fixture: input.fixture,
    adversity: input.adversity,
    receipt: protoReceipt,
  });
  const improvement = scoreImprovement(raw, prototype, input.adversity);
  return {
    comparison_valid: true,
    adversity: input.adversity,
    raw,
    prototype,
    improvement: improvement.kind,
    summary: improvement.summary,
  };
}
