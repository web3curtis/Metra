import { describe, expect, it } from "vitest";
import {
  PARCEL_FIXTURE_V0,
  ParcelStore,
  evaluateParcelOracle,
  parcelStructuredFailure,
} from "../../external-parcel-sandbox/src/parcelDomain.ts";
import { selectDiagnosisAction } from "../../reliability-boundary/diagnosis/diagnosisPolicy.ts";
import { buildStructuredFailure } from "../../reliability-boundary/semantics/structuredFailure.ts";

describe("external validity — ReliableParcel", () => {
  it("completes analogous confirm-once task", () => {
    const store = new ParcelStore(PARCEL_FIXTURE_V0);
    store.reset();
    store.holdSlot(PARCEL_FIXTURE_V0.winning_slot_id);
    const confirm = store.confirmDelivery("op_parcel_1");
    expect(confirm.ok).toBe(true);
    const dup = store.confirmDelivery("op_parcel_2");
    expect(dup.ok).toBe(false);
    const oracle = evaluateParcelOracle(PARCEL_FIXTURE_V0, store.getOrder());
    expect(oracle.ok).toBe(true);
  });

  it("reuses C1/C2 boundary ideas on parcel failures", () => {
    const mapped = parcelStructuredFailure("confirm_preconditions_unmet");
    const envelope = buildStructuredFailure({
      category: mapped.category,
      tool: "confirm_delivery",
      expected: "SLOT_HELD",
      actual: "EMPTY",
      state_revision: 0,
      evidence: ["external_parcel_contract"],
    });
    const decision = selectDiagnosisAction({ structuredFailure: envelope });
    expect(decision.action).toBe("stop");
  });
});
