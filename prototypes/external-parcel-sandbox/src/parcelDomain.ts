/**
 * External-validity surface: ReliableParcel (local second WebMCP app).
 * Analogous constrained multi-step simulated confirm — NOT mixed into ReliableRail causality.
 */

export type ParcelState = "EMPTY" | "SLOT_HELD" | "CONFIRMED";

export type ParcelOrder = {
  state: ParcelState;
  state_revision: number;
  slot_id: string | null;
  confirm_id: string | null;
  committed_confirm_count: number;
  total_aud: number | null;
};

export type ParcelFixture = {
  fixture_version: string;
  budget_aud: number;
  currency: string;
  slots: Array<{ slot_id: string; label: string; price_aud: number }>;
  winning_slot_id: string;
};

export const PARCEL_FIXTURE_V0: ParcelFixture = {
  fixture_version: "parcel-fixture-v0",
  budget_aud: 50,
  currency: "AUD",
  slots: [
    { slot_id: "SLOT-AM", label: "Morning locker", price_aud: 25 },
    { slot_id: "SLOT-PM", label: "Afternoon locker", price_aud: 40 },
  ],
  winning_slot_id: "SLOT-AM",
};

export class ParcelStore {
  private order: ParcelOrder = {
    state: "EMPTY",
    state_revision: 0,
    slot_id: null,
    confirm_id: null,
    committed_confirm_count: 0,
    total_aud: null,
  };

  constructor(private readonly fixture: ParcelFixture) {}

  getOrder(): ParcelOrder {
    return structuredClone(this.order);
  }

  reset(): ParcelOrder {
    this.order = {
      state: "EMPTY",
      state_revision: 0,
      slot_id: null,
      confirm_id: null,
      committed_confirm_count: 0,
      total_aud: null,
    };
    return this.getOrder();
  }

  private bump(next: Partial<ParcelOrder> & { state: ParcelState }) {
    this.order = {
      ...this.order,
      ...next,
      state_revision: this.order.state_revision + 1,
    };
  }

  listSlots() {
    return { ok: true as const, data: { slots: this.fixture.slots, currency: this.fixture.currency } };
  }

  holdSlot(slotId: string) {
    const slot = this.fixture.slots.find((s) => s.slot_id === slotId);
    if (!slot) return { ok: false as const, error: "unknown_slot" };
    if (slot.price_aud > this.fixture.budget_aud) {
      return { ok: false as const, error: "over_budget" };
    }
    this.bump({
      state: "SLOT_HELD",
      slot_id: slot.slot_id,
      total_aud: slot.price_aud,
    });
    return { ok: true as const, data: this.getOrder() };
  }

  confirmDelivery(operationId: string) {
    if (this.order.committed_confirm_count >= 1 || this.order.state === "CONFIRMED") {
      return {
        ok: false as const,
        error: "duplicate_confirm_rejected",
        data: { operation_id: operationId, order: this.getOrder() },
      };
    }
    if (this.order.state !== "SLOT_HELD" || !this.order.slot_id) {
      return { ok: false as const, error: "confirm_preconditions_unmet" };
    }
    const confirmId = `PARCEL-${operationId}`;
    this.bump({
      state: "CONFIRMED",
      confirm_id: confirmId,
      committed_confirm_count: this.order.committed_confirm_count + 1,
    });
    return {
      ok: true as const,
      data: { confirm_id: confirmId, operation_id: operationId, order: this.getOrder() },
    };
  }
}

export function evaluateParcelOracle(
  fixture: ParcelFixture,
  order: ParcelOrder,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (order.state !== "CONFIRMED") reasons.push("not_confirmed");
  if (order.slot_id !== fixture.winning_slot_id) reasons.push("wrong_slot");
  if (order.committed_confirm_count !== 1) reasons.push("confirm_count");
  if ((order.total_aud ?? 999) > fixture.budget_aud) reasons.push("over_budget");
  return { ok: reasons.length === 0, reasons };
}

/**
 * Apply C1-style envelope + C2 stop on contract-like failure for external surface.
 */
export function parcelStructuredFailure(error: string): {
  category: string;
  recoverability: string;
} {
  if (error === "confirm_preconditions_unmet" || error === "unknown_slot") {
    return { category: "invalid_input_or_precondition", recoverability: "automatic" };
  }
  if (error === "duplicate_confirm_rejected") {
    return { category: "ambiguous_commit", recoverability: "automatic" };
  }
  return { category: "execution_error", recoverability: "unknown" };
}
