import { describe, expect, it } from "vitest";
import { decideRecovery } from "../../reliability-boundary/recovery/stateRecovery.ts";

describe("state recovery D2", () => {
  it("stops when already purchased", () => {
    const d = decideRecovery({
      tools_include_purchase: true,
      order_state: "PURCHASED",
      order_id: "ORD-1",
      receipt_id: "RCP-1",
      total_aud: 280,
      budget_aud: 300,
      seat_ids: ["A1", "A2"],
      price_drift: false,
      seat_drift: false,
    });
    expect(d.action).toBe("stop");
  });

  it("resumes from ORDER_REVIEWED when tools present", () => {
    const d = decideRecovery({
      tools_include_purchase: true,
      order_state: "ORDER_REVIEWED",
      order_id: null,
      receipt_id: null,
      total_aud: 280,
      budget_aud: 300,
      seat_ids: ["A1", "A2"],
      price_drift: false,
      seat_drift: false,
    });
    expect(d.action).toBe("resume");
  });

  it("restarts draft on seat drift", () => {
    const d = decideRecovery({
      tools_include_purchase: true,
      order_state: "SEATS_RESERVED",
      order_id: null,
      receipt_id: null,
      total_aud: 280,
      budget_aud: 300,
      seat_ids: ["B1", "B2"],
      expected_seat_ids: ["A1", "A2"],
      price_drift: false,
      seat_drift: true,
    });
    expect(d.action).toBe("restart_draft");
  });
});
