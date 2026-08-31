/**
 * Shared protocol spine for A–D2.
 * One identity model, closed state machines, append-only telemetry.
 */

export type ProtocolPhase =
  | "idle"
  | "observe"
  | "validate"
  | "plan"
  | "act"
  | "verify"
  | "classify"
  | "decide"
  | "terminal";

export type OperationPhase =
  | "none"
  | "intent_recorded"
  | "dispatched"
  | "committed"
  | "unknown"
  | "failed"
  | "reconciled";

export type RecoveryPhase =
  | "none"
  | "interrupted"
  | "reconstructing"
  | "revalidating"
  | "resuming"
  | "terminal_safe";

export type DecisionAction =
  | "continue"
  | "retry_safe"
  | "reobserve"
  | "reconcile"
  | "recover"
  | "stop"
  | "escalate";

export type EvidenceRef = {
  evidence_id: string;
  kind: "tool_result" | "state_snapshot" | "capability" | "oracle" | "journal" | "checkpoint";
  redacted: boolean;
};

export type ProtocolIdentities = {
  run_id: string;
  attempt_id: string;
  operation_id: string | null;
  contract_version: string;
  state_revision: number | null;
  document_epoch: string | null;
  session_epoch: string | null;
  capability_epoch: string | null;
};

export type ProtocolDecision = {
  action: DecisionAction;
  reason_code: string;
  evidence_refs: string[];
};

export type TelemetryEvent = {
  sequence: number;
  timestamp: string;
  run_id: string;
  attempt_id: string;
  operation_id: string | null;
  component: "spine" | "webmcp" | "app" | "agent" | "harness" | "evaluator";
  stage: string;
  event_type: string;
  protocol_phase: ProtocolPhase;
  operation_phase: OperationPhase;
  recovery_phase: RecoveryPhase;
  payload: Record<string, unknown>;
};

const PROTOCOL_TRANSITIONS: Record<ProtocolPhase, readonly ProtocolPhase[]> = {
  idle: ["observe", "terminal"],
  observe: ["validate", "terminal"],
  validate: ["plan", "decide", "terminal"],
  plan: ["act", "decide", "terminal"],
  act: ["verify", "classify", "decide", "terminal"],
  verify: ["classify", "decide", "terminal"],
  classify: ["decide", "terminal"],
  decide: ["observe", "validate", "plan", "act", "verify", "terminal"],
  terminal: [],
};

const OPERATION_TRANSITIONS: Record<OperationPhase, readonly OperationPhase[]> = {
  none: ["intent_recorded", "none"],
  intent_recorded: ["dispatched", "failed", "none"],
  dispatched: ["committed", "unknown", "failed"],
  committed: ["reconciled"],
  unknown: ["reconciled", "failed", "committed"],
  failed: ["reconciled", "none"],
  reconciled: ["none", "intent_recorded"],
};

const RECOVERY_TRANSITIONS: Record<RecoveryPhase, readonly RecoveryPhase[]> = {
  none: ["interrupted", "none"],
  interrupted: ["reconstructing", "terminal_safe"],
  reconstructing: ["revalidating", "terminal_safe"],
  revalidating: ["resuming", "terminal_safe"],
  resuming: ["none", "terminal_safe"],
  terminal_safe: [],
};

export const SPINE_CONTRACT_VERSION = "spine-v0";

export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

export function assertTransition<T extends string>(
  kind: string,
  from: T,
  to: T,
  allowed: Record<T, readonly T[]>,
): void {
  const ok = allowed[from]?.includes(to);
  if (!ok) {
    throw new Error(`illegal_${kind}_transition:${from}->${to}`);
  }
}

const REDACT_KEYS = new Set([
  "password",
  "token",
  "authorization",
  "api_key",
  "secret",
  "credit_card",
  "ssn",
]);

export function redactPayload(
  payload: Record<string, unknown>,
): { payload: Record<string, unknown>; redacted: boolean } {
  let redacted = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (REDACT_KEYS.has(key.toLowerCase()) || key.toLowerCase().includes("secret")) {
      out[key] = "[REDACTED]";
      redacted = true;
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = redactPayload(value as Record<string, unknown>);
      out[key] = nested.payload;
      redacted = redacted || nested.redacted;
    } else {
      out[key] = value;
    }
  }
  return { payload: out, redacted };
}

export class ProtocolRunContext {
  readonly identities: ProtocolIdentities;
  protocol_phase: ProtocolPhase = "idle";
  operation_phase: OperationPhase = "none";
  recovery_phase: RecoveryPhase = "none";
  decision: ProtocolDecision | null = null;
  evidence: EvidenceRef[] = [];
  private sequence = 0;
  private readonly events: TelemetryEvent[] = [];

  constructor(seed?: Partial<ProtocolIdentities>) {
    this.identities = {
      run_id: seed?.run_id ?? newId("run"),
      attempt_id: seed?.attempt_id ?? newId("attempt"),
      operation_id: seed?.operation_id ?? null,
      contract_version: seed?.contract_version ?? SPINE_CONTRACT_VERSION,
      state_revision: seed?.state_revision ?? null,
      document_epoch: seed?.document_epoch ?? null,
      session_epoch: seed?.session_epoch ?? null,
      capability_epoch: seed?.capability_epoch ?? null,
    };
  }

  bumpAttempt(): void {
    this.identities.attempt_id = newId("attempt");
  }

  setOperationId(operationId: string | null): void {
    this.identities.operation_id = operationId;
  }

  setStateRevision(revision: number | null): void {
    this.identities.state_revision = revision;
  }

  setEpochs(epochs: {
    document_epoch?: string | null;
    session_epoch?: string | null;
    capability_epoch?: string | null;
  }): void {
    if (epochs.document_epoch !== undefined) this.identities.document_epoch = epochs.document_epoch;
    if (epochs.session_epoch !== undefined) this.identities.session_epoch = epochs.session_epoch;
    if (epochs.capability_epoch !== undefined) {
      this.identities.capability_epoch = epochs.capability_epoch;
    }
  }

  transitionProtocol(to: ProtocolPhase): void {
    assertTransition("protocol", this.protocol_phase, to, PROTOCOL_TRANSITIONS);
    this.protocol_phase = to;
  }

  transitionOperation(to: OperationPhase): void {
    assertTransition("operation", this.operation_phase, to, OPERATION_TRANSITIONS);
    this.operation_phase = to;
  }

  transitionRecovery(to: RecoveryPhase): void {
    assertTransition("recovery", this.recovery_phase, to, RECOVERY_TRANSITIONS);
    this.recovery_phase = to;
  }

  addEvidence(ref: EvidenceRef): void {
    this.evidence.push(ref);
  }

  setDecision(decision: ProtocolDecision): void {
    this.decision = decision;
    this.record({
      component: "spine",
      stage: "decide",
      event_type: "decision_set",
      payload: { ...decision },
    });
  }

  clearDecision(reason_code = "cleared"): void {
    if (!this.decision) return;
    this.record({
      component: "spine",
      stage: "decide",
      event_type: "decision_cleared",
      payload: { prior: this.decision.action, reason_code },
    });
    this.decision = null;
  }

  /**
   * Enforce C2/D2 decisions at the boundary.
   * Returns null when dispatch is allowed; otherwise a stable block code.
   */
  assertDispatchAllowed(input: {
    tool: string;
    readOnly: boolean;
    isReconcileTool?: boolean;
  }): { ok: true } | { ok: false; code: string; action: DecisionAction } {
    const action = this.decision?.action;
    if (!action || action === "continue") return { ok: true };

    const reconcileTool = input.isReconcileTool ?? input.tool === "get_order";

    switch (action) {
      case "stop":
      case "escalate":
        if (input.readOnly || reconcileTool) return { ok: true };
        return { ok: false, code: "decision_blocks_dispatch", action };
      case "reconcile":
        if (reconcileTool || input.readOnly) return { ok: true };
        return { ok: false, code: "decision_requires_reconcile", action };
      case "reobserve":
        if (input.readOnly) return { ok: true };
        return { ok: false, code: "decision_requires_reobserve", action };
      case "recover":
        if (input.readOnly || reconcileTool) return { ok: true };
        return { ok: false, code: "decision_requires_recover", action };
      case "retry_safe":
        return { ok: true };
      default: {
        const _exhaustive: never = action;
        return _exhaustive;
      }
    }
  }

  noteSuccessfulObserve(): void {
    if (this.decision?.action === "reobserve") {
      this.clearDecision("reobserve_satisfied");
    }
  }

  noteSuccessfulReconcile(): void {
    if (this.decision?.action === "reconcile") {
      this.clearDecision("reconcile_satisfied");
    }
  }

  record(
    partial: Omit<
      TelemetryEvent,
      | "sequence"
      | "timestamp"
      | "run_id"
      | "attempt_id"
      | "operation_id"
      | "protocol_phase"
      | "operation_phase"
      | "recovery_phase"
    > & { timestamp?: string },
  ): TelemetryEvent {
    this.sequence += 1;
    const { payload, redacted } = redactPayload(partial.payload);
    const event: TelemetryEvent = {
      sequence: this.sequence,
      timestamp: partial.timestamp ?? new Date().toISOString(),
      run_id: this.identities.run_id,
      attempt_id: this.identities.attempt_id,
      operation_id: this.identities.operation_id,
      component: partial.component,
      stage: partial.stage,
      event_type: partial.event_type,
      protocol_phase: this.protocol_phase,
      operation_phase: this.operation_phase,
      recovery_phase: this.recovery_phase,
      payload: redacted ? { ...payload, _redacted: true } : payload,
    };
    this.events.push(event);
    return event;
  }

  allEvents(): TelemetryEvent[] {
    return [...this.events];
  }

  toJsonl(): string {
    return this.events.map((e) => JSON.stringify(e)).join("\n") + (this.events.length ? "\n" : "");
  }

  snapshot(): {
    identities: ProtocolIdentities;
    protocol_phase: ProtocolPhase;
    operation_phase: OperationPhase;
    recovery_phase: RecoveryPhase;
    decision: ProtocolDecision | null;
    evidence: EvidenceRef[];
  } {
    return {
      identities: { ...this.identities },
      protocol_phase: this.protocol_phase,
      operation_phase: this.operation_phase,
      recovery_phase: this.recovery_phase,
      decision: this.decision ? { ...this.decision, evidence_refs: [...this.decision.evidence_refs] } : null,
      evidence: [...this.evidence],
    };
  }
}

/**
 * True when a reconcile result actually settled the question of the effect.
 * Tools that do not report an authority are treated as resolved, so this stays
 * compatible with reconcilers written before the field existed.
 */
function reconcileResolved(result: unknown): boolean {
  if (!result || typeof result !== "object") return true;
  const data = (result as { data?: unknown }).data;
  if (!data || typeof data !== "object") return true;
  const authority = (data as { authority?: unknown }).authority;
  if (authority === undefined || authority === null) return true;
  return authority === "authoritative";
}

export type BoundaryInvoke = (
  name: string,
  args: Record<string, unknown>,
  ctx: ProtocolRunContext,
) => unknown;

/**
 * Central registration boundary: every supported tool execute goes through one wrapper
 * that stamps shared identities into telemetry and enforces the last C2/D2 decision.
 */
export function wrapRegisteredToolExecute(
  toolName: string,
  handler: (args: Record<string, unknown>) => unknown,
  ctx: ProtocolRunContext,
  options: {
    readOnly?: boolean;
    isReconcileTool?: boolean;
    /**
     * Builds the refusal a caller receives when the decision gate blocks dispatch.
     * Without it the gate would answer in a different shape from every other
     * refusal, which is exactly the inconsistency an agent cannot handle.
     */
    describeBlock?: (input: { tool: string; code: string; action: DecisionAction }) => unknown;
  } = {},
): (args: Record<string, unknown>) => unknown {
  return (args: Record<string, unknown>) => {
    const readOnly = Boolean(options.readOnly);

    // Begin or continue the direction loop for this tool call.
    if (ctx.protocol_phase === "idle") {
      ctx.transitionProtocol("observe");
    } else if (ctx.protocol_phase === "classify" || ctx.protocol_phase === "decide") {
      if (ctx.protocol_phase === "classify") ctx.transitionProtocol("decide");
      ctx.transitionProtocol("observe");
    } else if (ctx.protocol_phase === "verify") {
      ctx.transitionProtocol("classify");
      ctx.transitionProtocol("decide");
      ctx.transitionProtocol("observe");
    }

    if (ctx.protocol_phase === "observe") ctx.transitionProtocol("validate");
    if (ctx.protocol_phase === "validate") ctx.transitionProtocol("plan");

    const gate = ctx.assertDispatchAllowed({
      tool: toolName,
      readOnly,
      isReconcileTool: options.isReconcileTool,
    });
    if (!gate.ok) {
      ctx.record({
        component: "spine",
        stage: "boundary",
        event_type: "boundary_blocked",
        payload: {
          tool: toolName,
          code: gate.code,
          action: gate.action,
        },
      });
      if (ctx.protocol_phase === "plan") ctx.transitionProtocol("decide");
      if (options.describeBlock) {
        return options.describeBlock({ tool: toolName, code: gate.code, action: gate.action });
      }
      return {
        ok: false,
        error: gate.code,
        data: {
          decision_action: gate.action,
          tool: toolName,
        },
      };
    }

    ctx.record({
      component: "spine",
      stage: "boundary",
      event_type: "boundary_enter",
      payload: {
        tool: toolName,
        read_only: readOnly,
        contract_version: ctx.identities.contract_version,
        identities: ctx.identities,
        prior_decision: ctx.decision?.action ?? null,
      },
    });

    if (!readOnly) {
      if (ctx.operation_phase === "committed" || ctx.operation_phase === "unknown" || ctx.operation_phase === "failed") {
        ctx.transitionOperation("reconciled");
      }
      if (ctx.operation_phase === "reconciled") {
        ctx.transitionOperation("none");
      }
      if (ctx.operation_phase === "none") ctx.transitionOperation("intent_recorded");
    }

    if (ctx.protocol_phase === "plan") ctx.transitionProtocol("act");
    if (!readOnly && ctx.operation_phase === "intent_recorded") {
      ctx.transitionOperation("dispatched");
    }

    try {
      const result = handler(args ?? {});
      const ok =
        typeof result === "object" && result !== null && "ok" in result
          ? Boolean((result as { ok?: unknown }).ok)
          : true;
      if (!readOnly && ctx.operation_phase === "dispatched") {
        ctx.transitionOperation(ok ? "committed" : "failed");
      }
      if (ok && readOnly) ctx.noteSuccessfulObserve();
      if (ok && (options.isReconcileTool || toolName === "get_order")) {
        // A reconcile that ran without resolving anything has not answered the
        // question that closed the gate. Treating it as satisfaction would let an
        // unverified effect be followed by a second one.
        if (reconcileResolved(result)) {
          ctx.noteSuccessfulReconcile();
        } else if (ctx.decision?.action === "reconcile") {
          ctx.setDecision({
            action: "escalate",
            reason_code: "reconcile_could_not_resolve_effect",
            evidence_refs: [toolName, ctx.identities.operation_id ?? "unknown_operation"],
          });
        }
      }
      ctx.transitionProtocol("verify");
      ctx.record({
        component: "spine",
        stage: "boundary",
        event_type: "boundary_exit",
        payload: { tool: toolName, ok },
      });
      ctx.transitionProtocol("classify");
      return result;
    } catch (error) {
      if (!readOnly && (ctx.operation_phase === "dispatched" || ctx.operation_phase === "intent_recorded")) {
        ctx.transitionOperation("failed");
      }
      if (ctx.protocol_phase === "act") {
        ctx.transitionProtocol("classify");
      }
      ctx.record({
        component: "spine",
        stage: "boundary",
        event_type: "boundary_error",
        payload: {
          tool: toolName,
          error: error instanceof Error ? error.message : "unknown_error",
        },
      });
      throw error;
    }
  };
}
