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
};

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

  if (observed.order_state === "PURCHASED" && observed.order_id && observed.receipt_id) {
    return {
      action: "stop",
      rationale: "Already purchased with receipt — do not resume purchase",
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

  if (
    observed.order_state === "ORDER_REVIEWED" ||
    observed.order_state === "SEATS_RESERVED" ||
    observed.order_state === "JOURNEYS_SELECTED"
  ) {
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
