/**
 * D2 — State-aware recovery after D1-safe effects.
 * Re-observe tools/order/receipt/price before resume or stop.
 */

export type RecoveryAction = "resume" | "restart_draft" | "stop" | "escalate";

export type ObservedRuntime = {
  tools_include_purchase: boolean;
  order_state: string;
  order_id: string | null;
  receipt_id: string | null;
  total_aud: number | null;
  budget_aud: number;
  seat_ids: string[];
  expected_seat_ids?: string[];
  price_drift: boolean;
  seat_drift: boolean;
  /**
   * States that mean the consequential effect is already done. Supplied by the
   * caller so this policy stays domain-neutral instead of knowing about orders.
   */
  committed_effect_states?: string[];
};

const DEFAULT_COMMITTED_STATES = ["PURCHASED"];

const RESUMABLE_DRAFT_STATES = ["ORDER_REVIEWED", "SEATS_RESERVED", "JOURNEYS_SELECTED"];

/**
 * Whether this policy can actually decide what to do from a given state. A
 * checkpoint may only be advertised as resumable when this returns true.
 */
export function recoveryPolicySupports(state: string, committedEffectStates: string[] = []): boolean {
  return (
    [...DEFAULT_COMMITTED_STATES, ...committedEffectStates].includes(state) ||
    RESUMABLE_DRAFT_STATES.includes(state) ||
    state === "EMPTY"
  );
}

export type RecoveryDecision = {
  action: RecoveryAction;
  rationale: string;
  evidence: string[];
};

export function decideRecovery(observed: ObservedRuntime): RecoveryDecision {
  const evidence: string[] = [
    `state:${observed.order_state}`,
    `purchase_tool:${observed.tools_include_purchase}`,
  ];

  const committedStates = [...DEFAULT_COMMITTED_STATES, ...(observed.committed_effect_states ?? [])];
  if (committedStates.includes(observed.order_state) && observed.order_id && observed.receipt_id) {
    return {
      action: "stop",
      rationale:
        observed.order_state === "PURCHASED"
          ? "Already purchased with receipt — do not resume purchase"
          : `Effect already committed in state ${observed.order_state} — do not repeat it`,
      evidence: [...evidence, `order:${observed.order_id}`, `receipt:${observed.receipt_id}`],
    };
  }

  if (!observed.tools_include_purchase) {
    return {
      action: "stop",
      rationale: "purchase_tickets missing after rediscovery — stop",
      evidence,
    };
  }

  if (observed.price_drift || (observed.total_aud !== null && observed.total_aud > observed.budget_aud)) {
    return {
      action: "stop",
      rationale: "Price drift or over budget after re-observe — stop",
      evidence: [...evidence, "price_drift"],
    };
  }

  if (observed.seat_drift) {
    return {
      action: "restart_draft",
      rationale: "Seat drift — restart reservation draft",
      evidence: [...evidence, "seat_drift"],
    };
  }

  if (RESUMABLE_DRAFT_STATES.includes(observed.order_state)) {
    return {
      action: "resume",
      rationale: `Re-observed ${observed.order_state}; resume from checkpoint`,
      evidence,
    };
  }

  if (observed.order_state === "EMPTY") {
    return {
      action: "restart_draft",
      rationale: "Empty after reload — restart draft",
      evidence,
    };
  }

  return {
    action: "escalate",
    rationale: "Unrecognized post-reload state",
    evidence,
  };
}
