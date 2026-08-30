/**
 * Genuine-feeling Syd–CBR booking surface (still simulated — no payments).
 * Adversities can be injected along the journey to stress A–D2.
 */

import type { Fixture } from "../domain/types.ts";
import {
  runSideBySideComparison,
  type SideBySideResult,
} from "../harness/sideBySideComparison.ts";
import {
  runFullAdversityBattery,
  type BatteryReport,
} from "../harness/fullAdversityBattery.ts";
import type { AdversityId } from "../adversity/adversityEngine.ts";

export type BookingStep =
  | "search"
  | "select"
  | "seats"
  | "review"
  | "confirm"
  | "done";

export type BookingViewModel = {
  step: BookingStep;
  passengers: number;
  budget_aud: number;
  outbound_label: string;
  return_label: string;
  seat_label: string;
  total_aud: number;
  stress_adversity: AdversityId;
};

export function initialBookingView(fixture: Fixture): BookingViewModel {
  const out = fixture.journeys.find(
    (j) => j.journey_id === fixture.task_target.outbound_journey_id,
  );
  const ret = fixture.journeys.find(
    (j) => j.journey_id === fixture.task_target.return_journey_id,
  );
  return {
    step: "search",
    passengers: fixture.passenger_count,
    budget_aud: fixture.budget_aud,
    outbound_label: out
      ? `${out.origin} → ${out.destination} · ${out.depart_at}`
      : "Outbound",
    return_label: ret
      ? `${ret.origin} → ${ret.destination} · ${ret.depart_at}`
      : "Return",
    seat_label: fixture.default_adjacent_pair.join(" + "),
    total_aud: 280,
    stress_adversity: "client_timeout_after_commit",
  };
}

export function nextBookingStep(step: BookingStep): BookingStep {
  switch (step) {
    case "search":
      return "select";
    case "select":
      return "seats";
    case "seats":
      return "review";
    case "review":
      return "confirm";
    case "confirm":
      return "done";
    case "done":
      return "done";
    default: {
      const _exhaustive: never = step;
      return _exhaustive;
    }
  }
}

/** Map booking step to the adversity that fires when leaving that step / confirming. */
export function adversityForConfirm(selected: AdversityId): AdversityId {
  return selected;
}

export function runBookingStressComparison(
  fixture: Fixture,
  adversity: AdversityId,
): SideBySideResult {
  return runSideBySideComparison({ fixture, adversity });
}

export function runBookingFullBattery(fixture: Fixture): BatteryReport {
  return runFullAdversityBattery(fixture);
}

export function bookingStepCopy(step: BookingStep): { title: string; body: string } {
  switch (step) {
    case "search":
      return {
        title: "Search Sydney – Canberra",
        body: "Find return trains for two passengers. Simulated inventory only — no real tickets or payments.",
      };
    case "select":
      return {
        title: "Choose your trains",
        body: "Select outbound and return services from the fixed June 2030 schedule.",
      };
    case "seats":
      return {
        title: "Pick adjacent seats",
        body: "Standard class · two adjacent seats required.",
      };
    case "review":
      return {
        title: "Review order",
        body: "Confirm AUD total ≤ 300 before purchase. Still simulated.",
      };
    case "confirm":
      return {
        title: "Confirm purchase",
        body: "Finalize exactly once. Reliability stresses (timeout, stale tools, reload…) may apply here.",
      };
    case "done":
      return {
        title: "Complete",
        body: "Order finished or safely stopped. Compare raw vs protected outcome below.",
      };
    default: {
      const _exhaustive: never = step;
      return { title: String(_exhaustive), body: "" };
    }
  }
}
