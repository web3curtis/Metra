export type OrderState =
  | "EMPTY"
  | "JOURNEYS_SELECTED"
  | "SEATS_RESERVED"
  | "ORDER_REVIEWED"
  | "PURCHASED";

export type Journey = {
  journey_id: string;
  direction: "outbound" | "return";
  origin: string;
  destination: string;
  depart_at: string;
  arrive_at: string;
  class: string;
  price_per_passenger_aud: number;
  available: boolean;
};

export type Seat = {
  seat_id: string;
  row: number;
  column: string;
};

export type Fixture = {
  fixture_version: string;
  timezone: string;
  currency: string;
  passenger_count: number;
  budget_aud: number;
  class: string;
  require_adjacent_seats: boolean;
  origin: string;
  destination: string;
  journeys: Journey[];
  task_target: {
    outbound_depart_local: string;
    return_depart_local: string;
    outbound_journey_id: string;
    return_journey_id: string;
    expected_total_aud: number;
  };
  seat_map: {
    carriage: string;
    seats: Seat[];
    adjacent_pairs: string[][];
  };
  default_adjacent_pair: string[];
  order_id_prefix: string;
  receipt_id_prefix: string;
};

export type OrderSnapshot = {
  state: OrderState;
  state_revision: number;
  outbound_journey_id: string | null;
  return_journey_id: string | null;
  seat_ids: string[];
  reviewed: boolean;
  total_aud: number | null;
  currency: string;
  order_id: string | null;
  receipt_id: string | null;
  committed_purchase_count: number;
  passengers: number;
};

export type ToolResult<T = unknown> = {
  ok: boolean;
  error?: string;
  data?: T;
};
