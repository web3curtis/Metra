import { describe, expect, it } from "vitest";
import { selectDiagnosisAction } from "../../reliability-boundary/diagnosis/diagnosisPolicy.ts";
import { envelopeFromToolError } from "../../reliability-boundary/semantics/structuredFailure.ts";
import {
  exportEventsToCritiqorJsonl,
  mapEventToCritiqor,
} from "../../../adapters/critiqor/mapEvents.ts";

describe("diagnosis policy C2", () => {
  it("selects reobserve for stale envelope without Critiqor", () => {
    const sf = envelopeFromToolError({
      tool: "purchase_tickets",
      error: "stale_capability_epoch",
      state: "ORDER_REVIEWED",
      state_revision: 3,
    });
    const d = selectDiagnosisAction({ structuredFailure: sf });
    expect(d.action).toBe("reobserve");
    expect(d.critiqor_used).toBe(false);
  });

  it("selects stop for contract violation envelope", () => {
    const sf = envelopeFromToolError({
      tool: "purchase_tickets",
      error: "contract_violation",
      state: "EMPTY",
      state_revision: 0,
    });
    const d = selectDiagnosisAction({ structuredFailure: sf });
    expect(d.action).toBe("stop");
  });

  it("uses Critiqor when envelope absent", () => {
    const d = selectDiagnosisAction({
      structuredFailure: null,
      critiqorDiagnosis: {
        primary_diagnosis: {
          root_cause_failure_type: "runtime_error",
          recommended_next_action: "Inspect the highest-impact runtime error",
        },
      },
    });
    expect(d.action).toBe("escalate");
    expect(d.critiqor_used).toBe(true);
  });
});

describe("critiqor adapter map", () => {
  it("maps failed tool_result to error_event", () => {
    const mapped = mapEventToCritiqor({
      sequence: 1,
      timestamp: "2026-08-29T00:00:00.000Z",
      component: "webmcp",
      stage: "exp-c2",
      event_type: "tool_result",
      payload: { tool: "purchase_tickets", ok: false, error: "stale_capability_epoch" },
    });
    expect(mapped.event_type).toBe("error_event");
    expect(mapped.source_layer).toBe("reliablerail_adapter");
  });

  it("exports jsonl lines", () => {
    const jsonl = exportEventsToCritiqorJsonl([
      {
        sequence: 1,
        timestamp: "2026-08-29T00:00:00.000Z",
        component: "webmcp",
        stage: "exp-c2",
        event_type: "tool_call",
        payload: { tool: "search_journeys" },
      },
    ]);
    expect(jsonl.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(jsonl).event_type).toBe("tool_call");
  });
});
