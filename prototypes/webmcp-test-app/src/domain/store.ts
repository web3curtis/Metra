import type { Fixture, OrderSnapshot, ToolResult } from "./types.ts";

function areAdjacent(fixture: Fixture, seatIds: string[]): boolean {
  if (seatIds.length !== 2) return false;
  const [a, b] = [...seatIds].sort();
  return fixture.seat_map.adjacent_pairs.some((pair) => {
    const [p, q] = [...pair].sort();
    return p === a && q === b;
  });
}

function computeTotal(
  fixture: Fixture,
  outboundId: string | null,
  returnId: string | null,
): number | null {
  if (!outboundId || !returnId) return null;
  const outbound = fixture.journeys.find((j) => j.journey_id === outboundId);
  const ret = fixture.journeys.find((j) => j.journey_id === returnId);
  if (!outbound || !ret) return null;
  return (
    (outbound.price_per_passenger_aud + ret.price_per_passenger_aud) *
    fixture.passenger_count
  );
}

export function createEmptyOrder(fixture: Fixture): OrderSnapshot {
  return {
    state: "EMPTY",
    state_revision: 0,
    outbound_journey_id: null,
    return_journey_id: null,
    seat_ids: [],
    reviewed: false,
    total_aud: null,
    currency: fixture.currency,
    order_id: null,
    receipt_id: null,
    committed_purchase_count: 0,
    passengers: fixture.passenger_count,
  };
}

export class ReliableRailStore {
  private order: OrderSnapshot;
  private seq = 0;

  constructor(private readonly fixture: Fixture) {
    this.order = createEmptyOrder(fixture);
  }

  getFixture(): Fixture {
    return this.fixture;
  }

  getOrder(): OrderSnapshot {
    return structuredClone(this.order);
  }

  reset(): OrderSnapshot {
    this.order = createEmptyOrder(this.fixture);
    this.seq = 0;
    return this.getOrder();
  }

  /** Rehydrate authoritative ledger after real reload (D2). */
  hydrateOrder(snapshot: OrderSnapshot): OrderSnapshot {
    this.order = structuredClone(snapshot);
    this.seq = snapshot.state_revision;
    return this.getOrder();
  }

  private bump(next: Partial<OrderSnapshot> & { state: OrderSnapshot["state"] }) {
    this.order = {
      ...this.order,
      ...next,
      state_revision: this.order.state_revision + 1,
    };
  }

  searchJourneys(input: {
    origin?: string;
    destination?: string;
    direction?: "outbound" | "return";
  }): ToolResult {
    const journeys = this.fixture.journeys.filter((j) => {
      if (input.origin && j.origin !== input.origin) return false;
      if (input.destination && j.destination !== input.destination) return false;
      if (input.direction && j.direction !== input.direction) return false;
      return j.available;
    });
    return {
      ok: true,
      data: {
        timezone: this.fixture.timezone,
        currency: this.fixture.currency,
        journeys,
      },
    };
  }

  selectJourney(input: {
    outbound_journey_id: string;
    return_journey_id: string;
  }): ToolResult {
    if (this.order.state === "PURCHASED") {
      return { ok: false, error: "order_already_purchased" };
    }
    const outbound = this.fixture.journeys.find(
      (j) => j.journey_id === input.outbound_journey_id && j.direction === "outbound",
    );
    const ret = this.fixture.journeys.find(
      (j) => j.journey_id === input.return_journey_id && j.direction === "return",
    );
    if (!outbound || !ret) {
      return { ok: false, error: "unknown_journey" };
    }
    if (outbound.class !== this.fixture.class || ret.class !== this.fixture.class) {
      return { ok: false, error: "invalid_class" };
    }
    const total = computeTotal(
      this.fixture,
      input.outbound_journey_id,
      input.return_journey_id,
    );
    this.bump({
      state: "JOURNEYS_SELECTED",
      outbound_journey_id: input.outbound_journey_id,
      return_journey_id: input.return_journey_id,
      seat_ids: [],
      reviewed: false,
      total_aud: total,
      order_id: null,
      receipt_id: null,
    });
    return { ok: true, data: this.getOrder() };
  }

  reserveSeats(input: { seat_ids: string[] }): ToolResult {
    if (this.order.state !== "JOURNEYS_SELECTED" && this.order.state !== "SEATS_RESERVED") {
      return { ok: false, error: "invalid_state_for_reserve" };
    }
    if (input.seat_ids.length !== this.fixture.passenger_count) {
      return { ok: false, error: "seat_count_mismatch" };
    }
    const known = new Set(this.fixture.seat_map.seats.map((s) => s.seat_id));
    if (input.seat_ids.some((id) => !known.has(id))) {
      return { ok: false, error: "unknown_seat" };
    }
    if (this.fixture.require_adjacent_seats && !areAdjacent(this.fixture, input.seat_ids)) {
      return { ok: false, error: "seats_not_adjacent" };
    }
    this.bump({
      state: "SEATS_RESERVED",
      seat_ids: [...input.seat_ids],
      reviewed: false,
      order_id: null,
      receipt_id: null,
    });
    return { ok: true, data: this.getOrder() };
  }

  reviewOrder(): ToolResult {
    if (this.order.state !== "SEATS_RESERVED" && this.order.state !== "ORDER_REVIEWED") {
      return { ok: false, error: "invalid_state_for_review" };
    }
    const total = computeTotal(
      this.fixture,
      this.order.outbound_journey_id,
      this.order.return_journey_id,
    );
    if (total === null) {
      return { ok: false, error: "incomplete_itinerary" };
    }
    if (total > this.fixture.budget_aud) {
      return { ok: false, error: "over_budget", data: { total_aud: total } };
    }
    this.bump({
      state: "ORDER_REVIEWED",
      reviewed: true,
      total_aud: total,
    });
    return {
      ok: true,
      data: {
        order: this.getOrder(),
        budget_aud: this.fixture.budget_aud,
        within_budget: true,
      },
    };
  }

  purchaseTickets(): ToolResult {
    if (this.order.committed_purchase_count >= 1 || this.order.state === "PURCHASED") {
      return {
        ok: false,
        error: "duplicate_purchase_rejected",
        data: this.getOrder(),
      };
    }
    if (this.order.state !== "ORDER_REVIEWED" || !this.order.reviewed) {
      return { ok: false, error: "purchase_preconditions_unmet" };
    }
    if (
      this.order.total_aud === null ||
      this.order.total_aud > this.fixture.budget_aud
    ) {
      return { ok: false, error: "over_budget" };
    }
    this.seq += 1;
    const orderId = `${this.fixture.order_id_prefix}-${String(this.seq).padStart(4, "0")}`;
    const receiptId = `${this.fixture.receipt_id_prefix}-${String(this.seq).padStart(4, "0")}`;
    this.bump({
      state: "PURCHASED",
      order_id: orderId,
      receipt_id: receiptId,
      committed_purchase_count: this.order.committed_purchase_count + 1,
    });
    return {
      ok: true,
      data: {
        order_id: orderId,
        receipt_id: receiptId,
        total_aud: this.order.total_aud,
        currency: this.order.currency,
        journeys: {
          outbound: this.order.outbound_journey_id,
          return: this.order.return_journey_id,
        },
        seats: this.order.seat_ids,
        state: this.order.state,
        note: "Simulated local finalization only. No payment processed.",
      },
    };
  }

  getOrderTool(): ToolResult {
    return { ok: true, data: this.getOrder() };
  }

  listAvailableSeats(): ToolResult {
    return {
      ok: true,
      data: {
        carriage: this.fixture.seat_map.carriage,
        seats: this.fixture.seat_map.seats,
        adjacent_pairs: this.fixture.seat_map.adjacent_pairs,
        passenger_count: this.fixture.passenger_count,
        require_adjacent_seats: this.fixture.require_adjacent_seats,
      },
    };
  }

  cancelDraft(): ToolResult {
    if (this.order.state === "PURCHASED") {
      return { ok: false, error: "cannot_cancel_purchased" };
    }
    this.order = createEmptyOrder(this.fixture);
    return { ok: true, data: this.getOrder() };
  }
}
