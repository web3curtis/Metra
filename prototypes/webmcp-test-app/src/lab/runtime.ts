import type { Adversity, UseCase } from "./catalog.ts";

export type DirectionStep = "observe" | "validate" | "act" | "verify" | "stop";
export type TraceStatus = "ok" | "warn" | "fail";

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

export class SuiteToolRuntime {
  private revision = 1;
  private effects = new Map<string, { id: string; status: "committed" }>();

  reset(): void {
    this.revision = 1;
    this.effects.clear();
  }

  execute(useCase: UseCase, toolName: string, args: Record<string, unknown>) {
    const tool = useCase.tools.find((item) => item.name === toolName);
    if (!tool) return { ok: false, error: "unknown_tool" };

    if (tool.readOnly) {
      const operationId = typeof args.operation_id === "string" ? args.operation_id : null;
      return {
        ok: true,
        data: {
          use_case: useCase.id,
          object: useCase.objectLabel,
          revision: this.revision,
          operation_id: operationId,
          effect: operationId ? this.effects.get(operationId) ?? null : null,
          simulated: true,
        },
      };
    }

    const operationId = typeof args.operation_id === "string" ? args.operation_id : "";
    const expectedRevision = Number(args.expected_revision);
    if (!operationId || !Number.isInteger(expectedRevision)) {
      return { ok: false, error: "contract_violation", allowed_next_action: "stop" };
    }
    if (expectedRevision !== this.revision) {
      return {
        ok: false,
        error: "stale_revision",
        expected_revision: expectedRevision,
        actual_revision: this.revision,
        allowed_next_action: "reobserve",
      };
    }
    const existing = this.effects.get(operationId);
    if (existing) {
      return { ok: true, data: { ...existing, duplicate_prevented: true, simulated: true } };
    }
    const effect = { id: `${useCase.id}_${this.effects.size + 1}`, status: "committed" as const };
    this.effects.set(operationId, effect);
    this.revision += 1;
    return {
      ok: true,
      data: {
        ...effect,
        operation_id: operationId,
        revision: this.revision,
        effect_count: this.effects.size,
        simulated: true,
      },
    };
  }
}
