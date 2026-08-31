import { describe, expect, it } from "vitest";
import { ProtocolRunContext } from "../../reliability-boundary/spine/protocolSpine.ts";
import {
  createVerifiedCheckpoint,
  verifyCheckpointIntegrity,
  recoverFromInterruption,
} from "../../reliability-boundary/recovery/checkpoint.ts";

describe("D2 checkpoint recovery", () => {
  it("accepts intact unexpired checkpoints and resumes reviewed drafts", () => {
    const protocol = new ProtocolRunContext({
      document_epoch: "doc:1",
      session_epoch: "sess:1",
    });
    const cp = createVerifiedCheckpoint({
      protocol,
      order_state: "ORDER_REVIEWED",
      order_id: null,
      receipt_id: null,
      state_revision: 4,
      postconditions_met: true,
    });
    expect(verifyCheckpointIntegrity(cp).ok).toBe(true);
    const recovered = recoverFromInterruption({
      protocol,
      checkpoint: cp,
      current_document_epoch: "doc:1",
      current_session_epoch: "sess:1",
      ambiguous_effect_pending: false,
      observed: {
        tools_include_purchase: true,
        order_state: "ORDER_REVIEWED",
        order_id: null,
        receipt_id: null,
        total_aud: 100,
        budget_aud: 200,
        seat_ids: ["1A", "1B"],
        price_drift: false,
        seat_drift: false,
      },
    });
    expect(recovered.integrity.ok).toBe(true);
    expect(recovered.decision.action).toBe("resume");
    expect(recovered.requires_ab_revalidation).toBe(true);
  });

  it("rejects corrupt or expired checkpoints", () => {
    const protocol = new ProtocolRunContext();
    const cp = createVerifiedCheckpoint({
      protocol,
      order_state: "PURCHASED",
      order_id: "o1",
      receipt_id: "r1",
      state_revision: 9,
      postconditions_met: true,
      ttl_ms: 1,
      now_ms: 1000,
    });
    expect(verifyCheckpointIntegrity(cp, 5000).ok).toBe(false);
    const tampered = { ...cp, integrity_hash: "chk_deadbeef" };
    expect(verifyCheckpointIntegrity(tampered, 1000).reason).toBe("integrity_mismatch");
  });

  it("forces reconcile before resume when effect is ambiguous", () => {
    const protocol = new ProtocolRunContext({ document_epoch: "doc:1", session_epoch: "sess:1" });
    protocol.transitionRecovery("interrupted");
    const cp = createVerifiedCheckpoint({
      protocol,
      order_state: "ORDER_REVIEWED",
      order_id: null,
      receipt_id: null,
      state_revision: 3,
      postconditions_met: true,
    });
    const recovered = recoverFromInterruption({
      protocol,
      checkpoint: cp,
      current_document_epoch: "doc:1",
      current_session_epoch: "sess:1",
      ambiguous_effect_pending: true,
      observed: {
        tools_include_purchase: true,
        order_state: "ORDER_REVIEWED",
        order_id: null,
        receipt_id: null,
        total_aud: 100,
        budget_aud: 200,
        seat_ids: ["1A", "1B"],
        price_drift: false,
        seat_drift: false,
      },
    });
    expect(recovered.decision.rationale).toMatch(/Ambiguous effect/);
  });
});
