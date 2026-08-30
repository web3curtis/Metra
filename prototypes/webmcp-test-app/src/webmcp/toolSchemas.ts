/** Concrete JSON Schema fragments for registered WebMCP tools. */

export const TOOL_INPUT_SCHEMAS: Record<string, object> = {
  search_journeys: {
    type: "object",
    properties: {
      origin: { type: "string" },
      destination: { type: "string" },
      direction: { type: "string", enum: ["outbound", "return"] },
    },
    additionalProperties: false,
  },
  select_journey: {
    type: "object",
    required: ["outbound_journey_id", "return_journey_id"],
    properties: {
      outbound_journey_id: { type: "string" },
      return_journey_id: { type: "string" },
    },
    additionalProperties: false,
  },
  list_available_seats: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  reserve_seats: {
    type: "object",
    required: ["seat_ids"],
    properties: {
      seat_ids: { type: "array", items: { type: "string" }, minItems: 1 },
    },
    additionalProperties: false,
  },
  review_order: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  purchase_tickets: {
    type: "object",
    properties: {
      operation_id: { type: "string" },
    },
    additionalProperties: false,
  },
  get_order: {
    type: "object",
    properties: {
      operation_id: { type: "string" },
    },
    additionalProperties: false,
  },
  cancel_draft: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};
