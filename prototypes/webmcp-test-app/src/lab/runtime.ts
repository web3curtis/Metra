import { buildStructuredFailure } from "../../../reliability-boundary/semantics/structuredFailure.ts";
import type { Adversity, UseCase } from "./catalog.ts";
import { getSuiteToolContract, producerOf } from "./suiteContracts.ts";

export type DirectionStep = "observe" | "validate" | "act" | "verify" | "stop";
export type TraceStatus = "ok" | "warn" | "fail";

type EffectRecord = {
  id: string;
  status: "committed";
  operation_id: string;
  revision_at_commit: number;
  record: Record<string, unknown>;
};

type Observation = {
  evidence_id: string;
  observed_revision: number;
  payload: Record<string, unknown>;
};

export type TraceEntry = {
  step: DirectionStep;
  label: string;
  detail: string;
  status: TraceStatus;
  call?: string;
};

export type LaneResult = {
  lane: "raw" | "guided";
  verdict: "PASS" | "FAIL";
  effectCount: number;
  callCount: number;
  directionScore: number;
  trace: TraceEntry[];
};

export type ComparisonResult = {
  runId: string;
  comparisonValid: true;
  adversity: Adversity;
  raw: LaneResult;
  guided: LaneResult;
};

export type RecordingFrame = {
  index: number;
  rawTraceCount: number;
  guidedTraceCount: number;
  timestampMs: number;
};

export type RunRecording = {
  runId: string;
  createdAt: string;
  durationMs: number;
  frames: RecordingFrame[];
  result: ComparisonResult;
};

function entry(
  step: DirectionStep,
  label: string,
  detail: string,
  status: TraceStatus,
  call?: string,
): TraceEntry {
  return { step, label, detail, status, call };
}

function rawLane(useCase: UseCase): LaneResult {
  const common = [
    entry("observe", "Tools discovered", `${useCase.tools.length} tools found. First plausible result selected.`, "ok", useCase.tools[0]?.name),
  ];

  if (useCase.adversity === "stale_state") {
    return {
      lane: "raw",
      verdict: "FAIL",
      effectCount: 0,
      callCount: 2,
      directionScore: 34,
      trace: [
        ...common,
        entry("act", "Acted on cached evidence", "Skipped revision refresh and submitted the stale selection.", "fail", useCase.tools[2]?.name),
        entry("stop", "Task ended unresolved", `The ${useCase.effectLabel} was not created; no recovery direction was chosen.`, "fail"),
      ],
    };
  }

  if (useCase.adversity === "ambiguous_commit") {
    return {
      lane: "raw",
      verdict: "FAIL",
      effectCount: 2,
      callCount: 3,
      directionScore: 22,
      trace: [
        ...common,
        entry("act", "Submitted action", `The ${useCase.effectLabel} committed, but the response timed out.`, "warn", useCase.tools[2]?.name),
        entry("act", "Blind retry", "A second operation ID was generated instead of reconciling the first.", "fail", useCase.tools[2]?.name),
        entry("stop", "Duplicate effect", `Authoritative effect count is 2; expected exactly 1.`, "fail"),
      ],
    };
  }

  return {
    lane: "raw",
    verdict: "FAIL",
    effectCount: 0,
    callCount: 1,
    directionScore: 18,
    trace: [
      entry("act", "Action attempted first", "Required evidence and state preconditions were not observed.", "fail", useCase.tools[2]?.name),
      entry("stop", "Opaque failure", "The action failed, but the run did not identify a safe next step.", "fail"),
    ],
  };
}

function guidedLane(useCase: UseCase): LaneResult {
  const trace: TraceEntry[] = [
    entry("observe", "Observe current state", useCase.objectLabel, "ok", useCase.tools[0]?.name),
    entry("validate", "Check task constraints", `${useCase.constraint}. Preconditions and expected revision are explicit.`, "ok"),
  ];

  if (useCase.adversity === "stale_state") {
    trace.push(
      entry("validate", "Revision changed", "Consequential call blocked because the observed revision is stale.", "warn", useCase.tools[2]?.name),
      entry("observe", "Re-observe", "Fresh authoritative state replaces cached evidence.", "ok", useCase.tools[1]?.name),
      entry("act", "Act once", `Created one ${useCase.effectLabel} with a stable operation ID.`, "ok", useCase.tools[2]?.name),
    );
  } else if (useCase.adversity === "ambiguous_commit") {
    trace.push(
      entry("act", "Act once", `Submitted one ${useCase.effectLabel}; response became ambiguous.`, "warn", useCase.tools[2]?.name),
      entry("verify", "Reconcile by operation ID", "Authoritative state proves the first action committed; retry is forbidden.", "ok", useCase.tools[3]?.name),
    );
  } else {
    trace.push(
      entry("validate", "Precondition blocked", "The invalid action did not reach the domain handler.", "warn", useCase.tools[2]?.name),
      entry("observe", "Collect missing evidence", "Required evidence and state were refreshed before continuing.", "ok", useCase.tools[1]?.name),
      entry("act", "Act after validation", `Created one valid ${useCase.effectLabel}.`, "ok", useCase.tools[2]?.name),
    );
  }

  trace.push(
    entry("verify", "Verify postcondition", `Authoritative effect count is 1 and the requested constraint still holds.`, "ok", useCase.tools[3]?.name),
    entry("stop", "Stop with evidence", "Task complete. No further consequential call is allowed.", "ok"),
  );

  return {
    lane: "guided",
    verdict: "PASS",
    effectCount: 1,
    callCount: trace.filter((item) => item.call).length,
    directionScore: 100,
    trace,
  };
}

export function runComparison(useCase: UseCase): ComparisonResult {
  return {
    runId: `run_${useCase.id}_${Date.now().toString(36)}`,
    comparisonValid: true,
    adversity: useCase.adversity,
    raw: rawLane(useCase),
    guided: guidedLane(useCase),
  };
}

export function createRecording(result: ComparisonResult, frameDurationMs = 900): RunRecording {
  const frameCount = Math.max(result.raw.trace.length, result.guided.trace.length);
  const frames = Array.from({ length: frameCount + 1 }, (_, index) => ({
    index,
    rawTraceCount: Math.min(index, result.raw.trace.length),
    guidedTraceCount: Math.min(index, result.guided.trace.length),
    timestampMs: index * frameDurationMs,
  }));
  return {
    runId: result.runId,
    createdAt: new Date().toISOString(),
    durationMs: frameCount * frameDurationMs,
    frames,
    result,
  };
}

/**
 * An operation_id identifies one effect inside one application, so the effect
 * table is keyed by both. A session-global key would let one application's
 * committed record answer another application's duplicate check.
 */
function effectKey(useCaseId: string, operationId: string): string {
  return `${useCaseId}\u0000${operationId}`;
}

export class SuiteToolRuntime {
  private revision = 1;
  private effects = new Map<string, EffectRecord>();
  private observations = new Map<string, Map<string, Observation>>();

  reset(): void {
    this.revision = 1;
    this.effects.clear();
    this.observations.clear();
  }

  effectCount(): number {
    return this.effects.size;
  }

  private bucket(useCaseId: string): Map<string, Observation> {
    let map = this.observations.get(useCaseId);
    if (!map) {
      map = new Map();
      this.observations.set(useCaseId, map);
    }
    return map;
  }

  execute(useCase: UseCase, toolName: string, args: Record<string, unknown>) {
    const tool = useCase.tools.find((item) => item.name === toolName);
    if (!tool) {
      return { ok: false, error: "unknown_tool", effect_count: this.effects.size };
    }

    const toolId = `${useCase.id}.${toolName}`;
    const contract = getSuiteToolContract(toolId);
    const role = tool.role ?? (tool.readOnly ? "inspect" : "act");

    if (role === "discover" || role === "inspect") {
      const evidenceId = tool.producesEvidence ?? `${useCase.id}.${toolName}`;
      const payload = {
        evidence_id: evidenceId,
        observed_revision: this.revision,
        revision: this.revision,
        use_case: useCase.id,
        ...(tool.observation ?? {}),
        simulated: true,
      };
      this.bucket(useCase.id).set(evidenceId, {
        evidence_id: evidenceId,
        observed_revision: this.revision,
        payload,
      });
      return { ok: true, data: payload };
    }

    if (role === "reconcile") {
      const operationId = typeof args.operation_id === "string" ? args.operation_id : "";
      if (!operationId) {
        const structured_failure = buildStructuredFailure({
          category: "invalid_input_or_precondition",
          tool: toolId,
          expected: "operation_id",
          actual: "missing_operation_id",
          owner: "reliability_boundary",
          recoverability: "automatic",
          state_revision: this.revision,
          evidence: ["reconcile_requires_operation_id"],
        });
        return {
          ok: false,
          error: "invalid_precondition",
          category: "invalid_input_or_precondition",
          allowed_next_action: "reconcile",
          effect_count: this.effects.size,
          structured_failure,
        };
      }
      const effect = this.effects.get(effectKey(useCase.id, operationId)) ?? null;
      return {
        ok: true,
        data: {
          operation_id: operationId,
          authority: effect ? "authoritative" : "unavailable",
          effect,
          effect_id: effect?.id ?? null,
          record: effect?.record ?? null,
          effect_count: this.effects.size,
          revision: this.revision,
          simulated: true,
        },
      };
    }

    const operationId = typeof args.operation_id === "string" ? args.operation_id : "";
    const expectedRevision = Number(args.expected_revision);
    if (!operationId || !Number.isInteger(expectedRevision)) {
      return {
        ok: false,
        error: "contract_violation",
        category: "invalid_input_or_precondition",
        allowed_next_action: "stop",
        effect_count: this.effects.size,
      };
    }

    // D1: the same operation_id in the same application reuses the committed
    // record before any stale/missing checks.
    const existing = this.effects.get(effectKey(useCase.id, operationId));
    if (existing) {
      return {
        ok: true,
        data: {
          ...existing,
          duplicate_prevented: true,
          effect_count: this.effects.size,
          revision: this.revision,
          simulated: true,
        },
      };
    }

    const required = tool.requiresEvidence ?? contract?.required_states ?? [];
    const missing = required.filter((key) => {
      const observed = this.bucket(useCase.id).get(key);
      return !observed || observed.observed_revision !== this.revision;
    });
    if (missing.length > 0) {
      const nextTool = producerOf(useCase.id, missing[0]!) ?? `${useCase.id}.observe`;
      const structured_failure = buildStructuredFailure({
        category: "invalid_input_or_precondition",
        tool: toolId,
        expected: required.join("+"),
        actual: `missing:${missing.join(",")}`,
        owner: "reliability_boundary",
        recoverability: "automatic",
        state_revision: this.revision,
        operation_id: operationId,
        evidence: ["required_states", ...missing],
      });
      return {
        ok: false,
        error: "invalid_precondition",
        category: "invalid_input_or_precondition",
        missing_evidence: missing,
        allowed_next_action: "observe",
        next_tool: nextTool,
        effect_count: this.effects.size,
        structured_failure,
      };
    }

    if (expectedRevision !== this.revision) {
      return {
        ok: false,
        error: "stale_revision",
        category: "stale_capability_or_state",
        expected_revision: expectedRevision,
        actual_revision: this.revision,
        allowed_next_action: "reobserve",
        effect_count: this.effects.size,
      };
    }

    const effect: EffectRecord = {
      id: `${useCase.id}_${this.effects.size + 1}`,
      status: "committed",
      operation_id: operationId,
      revision_at_commit: this.revision,
      record: { ...useCase.effectRecord, operation_id: operationId },
    };
    this.effects.set(effectKey(useCase.id, operationId), effect);
    this.revision += 1;
    return {
      ok: true,
      data: {
        id: effect.id,
        effect_id: effect.id,
        status: effect.status,
        operation_id: operationId,
        revision: this.revision,
        effect_count: this.effects.size,
        record: effect.record,
        simulated: true,
      },
    };
  }
}
