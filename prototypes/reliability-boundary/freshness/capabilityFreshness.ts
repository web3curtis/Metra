import type { ToolContract } from "../contract/contractV0.ts";
import { getToolContract } from "../contract/contractV0.ts";
import type { ProtocolRunContext } from "../spine/protocolSpine.ts";

export type FreshnessSnapshot = {
  capability_epoch: string | null;
  document_epoch: string | null;
  session_epoch: string | null;
  state_revision: number | null;
  source_evidence_ids: string[];
};

export type FreshnessDecision = {
  ok: boolean;
  code?: "stale_capability_epoch" | "missing_epoch" | "stale_dependency" | "irrelevant_change";
  expected?: string;
  actual?: string;
  dependency?: string;
  relevant?: boolean;
};

export type DriftEvent = {
  kind:
    | "tool_schema_change"
    | "capability_epoch_change"
    | "document_epoch_change"
    | "session_epoch_change"
    | "state_revision_change"
    | "unrelated_ui_text_change"
    | "missed_notification"
    | "race_before_dispatch";
  observed_at_ms: number;
};

/**
 * Classify whether a drift event is material for the planned consequential call.
 * Irrelevant UI text changes must not force reobservation.
 */
export function classifyDriftRelevance(input: {
  tool: string;
  planned: FreshnessSnapshot;
  current: FreshnessSnapshot;
  events: DriftEvent[];
  contract?: ToolContract;
}): {
  relevant: boolean;
  blocking: FreshnessDecision | null;
  ignored: DriftEvent[];
} {
  const ignored: DriftEvent[] = [];
  const relevantEvents: DriftEvent[] = [];
  for (const event of input.events) {
    if (event.kind === "unrelated_ui_text_change") {
      ignored.push(event);
      continue;
    }
    relevantEvents.push(event);
  }

  if (relevantEvents.length === 0) {
    return {
      relevant: false,
      blocking: {
        ok: true,
        code: "irrelevant_change",
        relevant: false,
      },
      ignored,
    };
  }

  // Missed notification / race: treat as forced re-check of dependencies.
  const forced = relevantEvents.some(
    (e) => e.kind === "missed_notification" || e.kind === "race_before_dispatch",
  );
  const decision = evaluateFreshness({
    tool: input.tool,
    planned: input.planned,
    current: input.current,
    contract: input.contract,
  });
  if (!decision.ok || forced) {
    return {
      relevant: true,
      blocking: decision.ok && forced
        ? {
            ok: false,
            code: "stale_dependency",
            dependency: "race_or_missed_notification",
            expected: "fresh_at_dispatch",
            actual: "race_or_missed_notification",
            relevant: true,
          }
        : { ...decision, relevant: true },
      ignored,
    };
  }
  return { relevant: false, blocking: { ok: true, relevant: false }, ignored };
}

export function computeEpoch(toolNames: string[]): string {
  const normalized = [...toolNames].map((n) => n.trim()).filter(Boolean).sort();
  return `epoch:${normalized.join("|")}`;
}

export function isStale(expected: string | undefined, actual: string | undefined): boolean {
  if (!expected || !actual) return true;
  return expected !== actual;
}

export function isConsequentialTool(tool: string, contract?: ToolContract): boolean {
  const c = contract ?? getToolContract(tool);
  if (!c) return false;
  return c.effect_class === "consequential_mutation" || c.effect_class === "externally_consequential";
}

/**
 * Dependency-bearing freshness check at the last safe moment.
 * Uses contract.freshness_dependencies when present; otherwise capability epoch only.
 */
export function evaluateFreshness(input: {
  tool: string;
  planned: FreshnessSnapshot;
  current: FreshnessSnapshot;
  contract?: ToolContract;
  protocol?: ProtocolRunContext;
}): FreshnessDecision {
  const contract = input.contract ?? getToolContract(input.tool);
  if (!isConsequentialTool(input.tool, contract)) {
    return { ok: true };
  }
  const deps = contract?.freshness_dependencies ?? ["capability_epoch"];
  for (const dep of deps) {
    if (dep === "capability_epoch") {
      if (!input.planned.capability_epoch || !input.current.capability_epoch) {
        return {
          ok: false,
          code: "missing_epoch",
          expected: input.planned.capability_epoch ?? undefined,
          actual: input.current.capability_epoch ?? undefined,
          dependency: dep,
        };
      }
      if (isStale(input.planned.capability_epoch, input.current.capability_epoch)) {
        return {
          ok: false,
          code: "stale_capability_epoch",
          expected: input.planned.capability_epoch,
          actual: input.current.capability_epoch,
          dependency: dep,
        };
      }
    }
    if (dep === "document_epoch") {
      if (
        input.planned.document_epoch &&
        input.current.document_epoch &&
        isStale(input.planned.document_epoch, input.current.document_epoch)
      ) {
        return {
          ok: false,
          code: "stale_dependency",
          expected: input.planned.document_epoch,
          actual: input.current.document_epoch,
          dependency: dep,
        };
      }
    }
    if (dep === "session_epoch") {
      if (
        input.planned.session_epoch &&
        input.current.session_epoch &&
        isStale(input.planned.session_epoch, input.current.session_epoch)
      ) {
        return {
          ok: false,
          code: "stale_dependency",
          expected: input.planned.session_epoch,
          actual: input.current.session_epoch,
          dependency: dep,
        };
      }
    }
    if (dep === "state_revision") {
      if (
        input.planned.state_revision !== null &&
        input.current.state_revision !== null &&
        input.planned.state_revision !== input.current.state_revision
      ) {
        return {
          ok: false,
          code: "stale_dependency",
          expected: String(input.planned.state_revision),
          actual: String(input.current.state_revision),
          dependency: dep,
        };
      }
    }
  }

  input.protocol?.record({
    component: "spine",
    stage: "freshness",
    event_type: "freshness_ok",
    payload: { tool: input.tool, deps },
  });
  return { ok: true };
}

/** Back-compat wrapper used by harness. */
export function rejectStaleConsequential(
  tool: string,
  expectedEpoch: string | undefined,
  actualEpoch: string | undefined,
  _consequential?: string[],
): FreshnessDecision {
  return evaluateFreshness({
    tool,
    planned: {
      capability_epoch: expectedEpoch ?? null,
      document_epoch: null,
      session_epoch: null,
      state_revision: null,
      source_evidence_ids: [],
    },
    current: {
      capability_epoch: actualEpoch ?? null,
      document_epoch: null,
      session_epoch: null,
      state_revision: null,
      source_evidence_ids: [],
    },
  });
}
