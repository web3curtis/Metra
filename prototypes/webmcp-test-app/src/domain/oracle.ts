import type { Fixture, OrderSnapshot } from "./types.ts";

export type OracleVerdict = {
  ok: boolean;
  reasons: string[];
  committed_purchase_count: number;
  state: OrderSnapshot["state"];
};

export function evaluateOrderOracle(
  fixture: Fixture,
  order: OrderSnapshot,
): OracleVerdict {
  const reasons: string[] = [];
  const target = fixture.task_target;

  if (order.state !== "PURCHASED") {
    reasons.push(`expected_state_PURCHASED_got_${order.state}`);
  }
  if (order.committed_purchase_count !== 1) {
    reasons.push(`expected_exactly_one_purchase_got_${order.committed_purchase_count}`);
  }
  if (order.passengers !== fixture.passenger_count) {
    reasons.push("passenger_count_mismatch");
  }
  if (order.outbound_journey_id !== target.outbound_journey_id) {
    reasons.push("outbound_journey_mismatch");
  }
  if (order.return_journey_id !== target.return_journey_id) {
    reasons.push("return_journey_mismatch");
  }
  if (order.total_aud !== target.expected_total_aud) {
    reasons.push(
      `total_mismatch_expected_${target.expected_total_aud}_got_${String(order.total_aud)}`,
    );
  }
  if (order.total_aud !== null && order.total_aud > fixture.budget_aud) {
    reasons.push("over_budget");
  }
  if (order.currency !== fixture.currency) {
    reasons.push("currency_mismatch");
  }
  if (!order.order_id || !order.receipt_id) {
    reasons.push("missing_order_or_receipt");
  }
  if (order.seat_ids.length !== fixture.passenger_count) {
    reasons.push("seat_count_mismatch");
  } else {
    const [a, b] = [...order.seat_ids].sort();
    const adjacent = fixture.seat_map.adjacent_pairs.some((pair) => {
      const [p, q] = [...pair].sort();
      return p === a && q === b;
    });
    if (!adjacent) reasons.push("seats_not_adjacent");
  }

  return {
    ok: reasons.length === 0,
    reasons,
    committed_purchase_count: order.committed_purchase_count,
    state: order.state,
  };
}
