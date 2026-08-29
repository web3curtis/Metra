export type ContractViolation = {
  code: string;
  field?: string;
  message: string;
};

export type CallValidationInput = {
  tool: string;
  args: Record<string, unknown>;
  state: string;
  currency?: string;
  budget_aud?: number;
  passenger_count?: number;
};

export type CallValidationResult = {
  ok: boolean;
  violations: ContractViolation[];
};

const PURCHASE_ALLOWED_STATES = new Set(["ORDER_REVIEWED"]);

/** Minimal Contract v0 call gate — Experiment A intervention. */
export function validateCall(input: CallValidationInput): CallValidationResult {
  const violations: ContractViolation[] = [];

  if (input.tool === "purchase_tickets") {
    if (!PURCHASE_ALLOWED_STATES.has(input.state)) {
      violations.push({
        code: "precondition_state",
        field: "state",
        message: `purchase_tickets requires ORDER_REVIEWED, got ${input.state}`,
      });
    }
  }

  if (input.tool === "select_journey") {
    if (!input.args.outbound_journey_id || !input.args.return_journey_id) {
      violations.push({
        code: "required_field",
        message: "outbound_journey_id and return_journey_id required",
      });
    }
  }

  if (input.tool === "reserve_seats") {
    const seats = input.args.seat_ids;
    if (!Array.isArray(seats) || seats.length === 0) {
      violations.push({
        code: "required_field",
        field: "seat_ids",
        message: "seat_ids required",
      });
    } else if (
      input.passenger_count !== undefined &&
      seats.length !== input.passenger_count
    ) {
      violations.push({
        code: "constraint",
        field: "seat_ids",
        message: `expected ${input.passenger_count} seats`,
      });
    }
  }

  if (input.currency && input.currency !== "AUD") {
    violations.push({
      code: "constraint",
      field: "currency",
      message: "currency must be AUD",
    });
  }

  return { ok: violations.length === 0, violations };
}

export type OutputValidationInput = {
  tool: string;
  ok: boolean;
  data?: unknown;
};

export function validateOutput(input: OutputValidationInput): CallValidationResult {
  const violations: ContractViolation[] = [];
  if (input.tool === "purchase_tickets" && input.ok) {
    const data = input.data as { order_id?: string; receipt_id?: string; currency?: string };
    if (!data?.order_id || !data?.receipt_id) {
      violations.push({
        code: "output_shape",
        message: "purchase success requires order_id and receipt_id",
      });
    }
    if (data?.currency && data.currency !== "AUD") {
      violations.push({
        code: "output_constraint",
        field: "currency",
        message: "currency must be AUD",
      });
    }
  }
  return { ok: violations.length === 0, violations };
}
