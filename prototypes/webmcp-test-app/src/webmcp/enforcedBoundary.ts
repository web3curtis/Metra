/**
 * Pre-dispatch reliability boundary for the registered WebMCP path.
 *
 * Every registered tool runs A (contract), B (freshness), C2 (decision) BEFORE the
 * domain handler is reachable, then C1 (outcome normalization), D1 (effect identity)
 * and D2 (verified checkpoint) after it. The domain runtime keeps its own copy of
 * these rules; this layer is the boundary that must hold even if a domain handler
 * is replaced, so a blocked consequential call provably never reaches the handler.
 */

import { createVerifiedCheckpoint, type VerifiedCheckpoint } from "../../../reliability-boundary/recovery/checkpoint.ts";
import {
  EffectJournal,
  intentFingerprint,
  type EffectPhase,
} from "../../../reliability-boundary/effect/effectSafety.ts";
import { normalizeOutcome, type NormalizedOutcome } from "../../../reliability-boundary/semantics/normalizeOutcome.ts";
import {
  buildStructuredFailure,
  type StructuredFailure,
} from "../../../reliability-boundary/semantics/structuredFailure.ts";
import type { ProtocolRunContext } from "../../../reliability-boundary/spine/protocolSpine.ts";
import type { LabTool, UseCase } from "../lab/catalog.ts";
import { getSuiteToolContract, producerOf, type SuiteToolContract } from "../lab/suiteContracts.ts";

export type Mechanism = "A" | "B" | "C1" | "C2" | "D1" | "D2";

export type NextAction = "observe" | "reobserve" | "reconcile" | "stop";

/** Envelope returned to the agent for every registered tool call. */
export type BoundaryEnvelope = {
  ok: boolean;
  error?: string;
  category?: string;
  data?: Record<string, unknown>;
  missing_evidence?: string[];
  stale_evidence?: string[];
  allowed_next_action?: NextAction;
  next_tool?: string | null;
  effect_count: number;
  structured_failure?: StructuredFailure;
  mechanisms: Mechanism[];
  checkpoint_id?: string;
  simulated: true;
};

type ObservationMirror = {
  evidence_id: string;
  observed_revision: number;
  observed_at_ms: number;
};

/**
 * An operation_id names one effect inside one application. The same session is
 * shared by every registered tool, so the committed phase has to be looked up
 * under the use case that produced it. A session-global key would let app A's
 * commit answer app B's duplicate question.
 */
function effectScope(useCaseId: string, operationId: string): string {
  return `${useCaseId}\u0000${operationId}`;
}

/**
 * Boundary state shared by every tool registered in one session. Mirrors only what
 * the boundary observes through registered calls, so it stays truthful even if the
 * domain runtime is swapped out.
 */
export class BoundarySession {
  readonly journal = new EffectJournal();
  private readonly observations = new Map<string, Map<string, ObservationMirror>>();
  private readonly committed = new Map<string, EffectPhase>();
  private readonly operationOwners = new Map<string, string>();
  private readonly checkpoints: VerifiedCheckpoint[] = [];
  private revision = 1;
  private effects = 0;

  currentRevision(): number {
    return this.revision;
  }

  effectCount(): number {
    return this.effects;
  }

  allCheckpoints(): VerifiedCheckpoint[] {
    return [...this.checkpoints];
  }

  latestCheckpoint(): VerifiedCheckpoint | null {
    return this.checkpoints.at(-1) ?? null;
  }

  phaseOf(useCaseId: string, operationId: string): EffectPhase {
    return this.committed.get(effectScope(useCaseId, operationId)) ?? "not_started";
  }

  /** The consequential tool that first bound this operation_id, if any. */
  operationOwner(operationId: string): string | null {
    return this.operationOwners.get(operationId) ?? null;
  }

  claimOperation(operationId: string, toolId: string): void {
    if (!this.operationOwners.has(operationId)) {
      this.operationOwners.set(operationId, toolId);
    }
  }

  observationsFor(useCaseId: string): Map<string, ObservationMirror> {
    let bucket = this.observations.get(useCaseId);
    if (!bucket) {
      bucket = new Map();
      this.observations.set(useCaseId, bucket);
    }
    return bucket;
  }

  recordObservation(useCaseId: string, evidenceId: string, observedRevision: number): void {
    this.observationsFor(useCaseId).set(evidenceId, {
      evidence_id: evidenceId,
      observed_revision: observedRevision,
      observed_at_ms: Date.now(),
    });
  }

  recordCommit(useCaseId: string, operationId: string, revisionAfter: number): void {
    const scope = effectScope(useCaseId, operationId);
    if (this.committed.get(scope) === "committed") return;
    this.committed.set(scope, "committed");
    this.effects += 1;
    this.revision = revisionAfter;
  }

  syncRevision(revision: number): void {
    if (Number.isInteger(revision) && revision > this.revision) this.revision = revision;
  }

  addCheckpoint(checkpoint: VerifiedCheckpoint): void {
    this.checkpoints.push(checkpoint);
  }
}

/** Evidence classification for a consequential call's declared preconditions. */
type EvidenceVerdict = {
  satisfied: string[];
  never_observed: string[];
  stale: string[];
};

function classifyEvidence(
  session: BoundarySession,
  useCaseId: string,
  required: string[],
): EvidenceVerdict {
  const verdict: EvidenceVerdict = { satisfied: [], never_observed: [], stale: [] };
  const bucket = session.observationsFor(useCaseId);
  for (const key of required) {
    const observed = bucket.get(key);
    if (!observed) {
      verdict.never_observed.push(key);
    } else if (observed.observed_revision !== session.currentRevision()) {
      verdict.stale.push(key);
    } else {
      verdict.satisfied.push(key);
    }
  }
  return verdict;
}

function emit(
  protocol: ProtocolRunContext,
  mechanism: Mechanism,
  event_type: string,
  payload: Record<string, unknown>,
): void {
  protocol.record({
    component: "webmcp",
    stage: `mechanism_${mechanism}`,
    event_type,
    payload: { mechanism, ...payload },
  });
}

function decisionFor(action: NextAction): "reobserve" | "reconcile" | "stop" {
  switch (action) {
    case "observe":
    case "reobserve":
      return "reobserve";
    case "reconcile":
      return "reconcile";
    case "stop":
      return "stop";
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

/** C1 + C2 + D2 for a call the boundary refuses to dispatch. */
function refuse(input: {
  protocol: ProtocolRunContext;
  session: BoundarySession;
  toolId: string;
  useCase: UseCase;
  error: string;
  structured_failure: StructuredFailure;
  allowed_next_action: NextAction;
  next_tool: string | null;
  missing_evidence?: string[];
  stale_evidence?: string[];
  operationId?: string;
  mechanisms: Mechanism[];
}): BoundaryEnvelope {
  const normalized = normalizeOutcome({
    tool: input.toolId,
    state: input.error,
    state_revision: input.session.currentRevision(),
    operation_id: input.operationId,
    kind: "tool_error",
    error: input.error,
  });
  emit(input.protocol, "C1", "outcome_normalized", {
    tool: input.toolId,
    kind: normalized.kind,
    commit_status: normalized.commit_status,
    authority: normalized.authority,
  });

  const decision = decisionFor(input.allowed_next_action);
  input.protocol.setDecision({
    action: decision,
    reason_code: input.error,
    evidence_refs: [
      ...(input.missing_evidence ?? []),
      ...(input.stale_evidence ?? []),
      input.toolId,
    ],
  });
  emit(input.protocol, "C2", "decision_bound", {
    tool: input.toolId,
    action: decision,
    single_legal_next_action: input.next_tool,
  });

  const checkpoint = createVerifiedCheckpoint({
    protocol: input.protocol,
    order_state: `${input.useCase.id}:BLOCKED_PRE_DISPATCH`,
    order_id: null,
    receipt_id: null,
    state_revision: input.session.currentRevision(),
    operation_journal_refs: input.operationId ? [input.operationId] : [],
    evidence_ids: [...(input.missing_evidence ?? []), ...(input.stale_evidence ?? [])],
    postconditions_met: false,
  });
  input.session.addCheckpoint(checkpoint);
  emit(input.protocol, "D2", "checkpoint_bound", {
    tool: input.toolId,
    checkpoint_id: checkpoint.checkpoint_id,
    resumable: true,
  });

  return {
    ok: false,
    error: input.error,
    category: input.structured_failure.category,
    missing_evidence: input.missing_evidence,
    stale_evidence: input.stale_evidence,
    allowed_next_action: input.allowed_next_action,
    next_tool: input.next_tool,
    effect_count: input.session.effectCount(),
    structured_failure: input.structured_failure,
    mechanisms: input.mechanisms,
    checkpoint_id: checkpoint.checkpoint_id,
    simulated: true,
  };
}

/** The subset of JSON Schema the registered tools actually declare. */
type ArgSpec = {
  type?: string;
  minimum?: number;
  minLength?: number;
};

/**
 * A — argument/shape validation against the machine-enforced contract.
 *
 * Constraints are read from the tool's declared input schema rather than
 * restated here, so a value the schema forbids cannot be coerced into an
 * accepted one. A string "1" is not an integer, and must fail closed.
 */
function validateShape(
  contract: SuiteToolContract,
  args: Record<string, unknown>,
  inputSchema: Record<string, unknown>,
): { ok: true } | { ok: false; detail: string } {
  const properties = (inputSchema.properties ?? {}) as Record<string, ArgSpec>;
  for (const key of contract.shape.required_args) {
    const value = args[key];
    const spec = properties[key] ?? {};

    if (spec.type === "integer") {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return { ok: false, detail: `${key}_not_integer` };
      }
      if (spec.minimum !== undefined && value < spec.minimum) {
        return { ok: false, detail: `${key}_below_minimum` };
      }
      continue;
    }

    if (typeof value !== "string" || value.length === 0) {
      return { ok: false, detail: `missing_${key}` };
    }
    if (spec.minLength !== undefined && value.length < spec.minLength) {
      return { ok: false, detail: `${key}_below_min_length` };
    }
  }
  if (contract.shape.unknown_field_policy === "reject") {
    const allowed = new Set(contract.shape.required_args);
    for (const key of Object.keys(args)) {
      if (!allowed.has(key)) return { ok: false, detail: `unknown_field_${key}` };
    }
  }
  return { ok: true };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function createEnforcedHandler(input: {
  useCase: UseCase;
  tool: LabTool;
  session: BoundarySession;
  protocol: ProtocolRunContext;
  handler: (args: Record<string, unknown>) => unknown;
}): (args: Record<string, unknown>) => BoundaryEnvelope {
  const { useCase, tool, session, protocol, handler } = input;
  const toolId = `${useCase.id}.${tool.name}`;

  return (rawArgs: Record<string, unknown>): BoundaryEnvelope => {
    const args = rawArgs ?? {};
    const contract = getSuiteToolContract(toolId);
    const mechanisms: Mechanism[] = [];

    if (!contract) {
      const structured_failure = buildStructuredFailure({
        category: "invalid_input_or_precondition",
        tool: toolId,
        expected: "registered_contract",
        actual: "no_contract",
        owner: "reliability_boundary",
        recoverability: "non_recoverable",
        state_revision: session.currentRevision(),
        evidence: ["contract_registry_miss"],
      });
      return refuse({
        protocol,
        session,
        toolId,
        useCase,
        error: "contract_violation",
        structured_failure,
        allowed_next_action: "stop",
        next_tool: null,
        mechanisms: ["A", "C1", "C2", "D2"],
      });
    }

    // A — contract validation happens before the domain handler is reachable.
    const shape = validateShape(contract, args, tool.inputSchema);
    mechanisms.push("A");
    emit(protocol, "A", "contract_validate", {
      tool: toolId,
      contract_version: contract.contract_version,
      effect_class: contract.shape.effect_class,
      required_args: contract.shape.required_args,
      valid: shape.ok,
    });
    if (!shape.ok) {
      const structured_failure = buildStructuredFailure({
        category: "invalid_input_or_precondition",
        tool: toolId,
        expected: contract.shape.required_args.join("+") || "valid_arguments",
        actual: shape.detail,
        owner: "reliability_boundary",
        recoverability: "automatic",
        state_revision: session.currentRevision(),
        evidence: ["contract_validate", shape.detail],
      });
      return refuse({
        protocol,
        session,
        toolId,
        useCase,
        error: "contract_violation",
        structured_failure,
        allowed_next_action: contract.role === "reconcile" ? "reconcile" : "stop",
        next_tool: null,
        mechanisms: [...mechanisms, "C1", "C2", "D2"],
      });
    }

    const operationId = typeof args.operation_id === "string" ? args.operation_id : undefined;

    // D1 — bind operation identity before any dispatch decision.
    if (operationId) {
      protocol.setOperationId(operationId);
      mechanisms.push("D1");
      const fingerprint = intentFingerprint({
        tool: toolId,
        args,
        state_revision: session.currentRevision(),
        contract_version: contract.contract_version,
      });
      const conflict = session.journal.conflictOnReuse({
        operation_id: operationId,
        intent_fingerprint: fingerprint,
      });
      const owner = session.operationOwner(operationId);
      session.journal.append({
        at_ms: Date.now(),
        operation_id: operationId,
        intent_fingerprint: fingerprint,
        tool: toolId,
        phase: session.phaseOf(useCase.id, operationId),
        note: conflict ? "intent_changed_under_same_operation_id" : "intent_recorded",
      });
      emit(protocol, "D1", "effect_identity_bound", {
        tool: toolId,
        operation_id: operationId,
        intent_fingerprint: fingerprint,
        prior_phase: session.phaseOf(useCase.id, operationId),
        intent_conflict: conflict,
        operation_owner: owner,
      });

      // One operation_id names one effect. A consequential call that reuses an
      // operation_id already bound to a different consequential tool is an
      // identity conflict, and must fail closed rather than inherit that tool's
      // duplicate-suppression or committed phase.
      if (contract.role === "act") {
        if (owner && owner !== toolId) {
          const structured_failure = buildStructuredFailure({
            category: "invalid_input_or_precondition",
            tool: toolId,
            expected: `operation_id_unbound_or_owned_by:${toolId}`,
            actual: `operation_id_owned_by:${owner}`,
            owner: "reliability_boundary",
            recoverability: "non_recoverable",
            state_revision: session.currentRevision(),
            operation_id: operationId,
            evidence: ["effect_identity_bound", owner],
          });
          return refuse({
            protocol,
            session,
            toolId,
            useCase,
            error: "operation_id_scope_conflict",
            structured_failure,
            allowed_next_action: "stop",
            next_tool: null,
            operationId,
            mechanisms: [...mechanisms, "C1", "C2", "D2"],
          });
        }
        session.claimOperation(operationId, toolId);

        // An existing committed record is reconciled before any staleness rejection.
        if (session.phaseOf(useCase.id, operationId) === "committed") {
          emit(protocol, "D1", "duplicate_suppressed_by_operation_id", {
            tool: toolId,
            operation_id: operationId,
          });
        }
      }
    }

    // B — freshness of the declared preconditions, evaluated pre-dispatch.
    if (contract.role === "act") {
      const verdict = classifyEvidence(session, useCase.id, contract.required_states);
      mechanisms.push("B");
      emit(protocol, "B", "freshness_evaluate", {
        tool: toolId,
        required_states: contract.required_states,
        satisfied: verdict.satisfied,
        never_observed: verdict.never_observed,
        stale: verdict.stale,
        state_revision: session.currentRevision(),
        freshness_dependencies: contract.freshness_dependencies,
      });

      const alreadyCommitted = operationId
        ? session.phaseOf(useCase.id, operationId) === "committed"
        : false;
      const blocking = [...verdict.never_observed, ...verdict.stale];
      if (blocking.length > 0 && !alreadyCommitted) {
        const stale = verdict.stale.length > 0;
        const structured_failure = buildStructuredFailure({
          category: stale ? "stale_capability_or_state" : "invalid_input_or_precondition",
          tool: toolId,
          expected: contract.required_states.join("+"),
          actual: stale
            ? `stale:${verdict.stale.join(",")}`
            : `missing:${verdict.never_observed.join(",")}`,
          owner: "reliability_boundary",
          recoverability: "automatic",
          state_revision: session.currentRevision(),
          operation_id: operationId,
          evidence: ["required_states", ...blocking],
        });
        return refuse({
          protocol,
          session,
          toolId,
          useCase,
          error: stale ? "stale_precondition" : "invalid_precondition",
          structured_failure,
          allowed_next_action: stale ? "reobserve" : "observe",
          next_tool: producerOf(useCase.id, blocking[0]!),
          missing_evidence: verdict.never_observed,
          stale_evidence: verdict.stale,
          operationId,
          mechanisms: [...mechanisms, "C1", "C2", "D2"],
        });
      }
    }

    // Dispatch is only reachable once A, B, C2 and D1 have all allowed it.
    let normalized: NormalizedOutcome;
    let raw: unknown;
    try {
      raw = handler(args);
    } catch (error) {
      normalized = normalizeOutcome({
        tool: toolId,
        state: "thrown",
        state_revision: session.currentRevision(),
        operation_id: operationId,
        kind: "thrown",
        error,
      });
      emit(protocol, "C1", "outcome_normalized", {
        tool: toolId,
        kind: normalized.kind,
        commit_status: normalized.commit_status,
      });
      return refuse({
        protocol,
        session,
        toolId,
        useCase,
        error: "execution_failure",
        structured_failure:
          normalized.structured_failure ??
          buildStructuredFailure({
            category: "execution_failure",
            tool: toolId,
            expected: "ok",
            actual: "thrown",
            state_revision: session.currentRevision(),
          }),
        allowed_next_action: contract.role === "act" ? "reconcile" : "stop",
        next_tool: contract.role === "act" ? reconcilerFor(useCase) : null,
        operationId,
        mechanisms: [...mechanisms, "C1", "C2", "D2"],
      });
    }

    const record = asRecord(raw);
    const handlerOk = record ? Boolean(record.ok) : false;
    const data = asRecord(record?.data) ?? {};

    // Domain fields live on the authoritative record; postconditions are checked
    // against the caller-visible union of envelope and record.
    const visible: Record<string, unknown> = {
      ...(asRecord(data.record) ?? {}),
      ...data,
      effect_id: data.effect_id ?? data.id,
    };

    // C1 — postcondition check turns an incomplete success into a typed failure.
    const missingPostconditions = handlerOk
      ? contract.postconditions.filter((field) => visible[field] === undefined)
      : [];
    normalized = normalizeOutcome({
      tool: toolId,
      state: handlerOk ? "ok" : String(record?.error ?? "tool_error"),
      state_revision: session.currentRevision(),
      operation_id: operationId,
      kind: handlerOk ? "success" : "tool_error",
      value: handlerOk ? data : undefined,
      error: handlerOk ? undefined : String(record?.error ?? "tool_error"),
      malformed: missingPostconditions.length > 0,
    });
    mechanisms.push("C1");
    emit(protocol, "C1", "outcome_normalized", {
      tool: toolId,
      kind: normalized.kind,
      commit_status: normalized.commit_status,
      authority: normalized.authority,
      missing_postconditions: missingPostconditions,
    });

    if (normalized.kind === "malformed_success") {
      return refuse({
        protocol,
        session,
        toolId,
        useCase,
        error: "malformed_success",
        structured_failure: normalized.structured_failure!,
        allowed_next_action: contract.role === "act" ? "reconcile" : "stop",
        next_tool: contract.role === "act" ? reconcilerFor(useCase) : null,
        operationId,
        mechanisms: [...mechanisms, "C2", "D2"],
      });
    }

    if (!handlerOk) {
      const nextAction: NextAction =
        String(record?.error) === "stale_revision" ? "reobserve" : contract.role === "act" ? "observe" : "stop";
      return refuse({
        protocol,
        session,
        toolId,
        useCase,
        error: String(record?.error ?? "execution_failure"),
        structured_failure:
          normalized.structured_failure ??
          buildStructuredFailure({
            category: "execution_failure",
            tool: toolId,
            expected: "ok",
            actual: String(record?.error ?? "unknown"),
            state_revision: session.currentRevision(),
          }),
        allowed_next_action: nextAction,
        next_tool: nextAction === "observe" ? producerOf(useCase.id, contract.required_states[0] ?? "") : null,
        operationId,
        mechanisms: [...mechanisms, "C2", "D2"],
      });
    }

    // Successful read: mirror the observation so freshness stays truthful.
    if (contract.produces_state) {
      const observedRevision = Number(data.observed_revision ?? data.revision ?? session.currentRevision());
      session.recordObservation(useCase.id, contract.produces_state, observedRevision);
      emit(protocol, "B", "observation_recorded", {
        tool: toolId,
        evidence_id: contract.produces_state,
        observed_revision: observedRevision,
      });
      if (!mechanisms.includes("B")) mechanisms.push("B");
    }

    if (contract.role === "reconcile") {
      mechanisms.push("D1");
      emit(protocol, "D1", "effect_reconciled", {
        tool: toolId,
        operation_id: operationId ?? null,
        authority: data.authority ?? "unavailable",
        effect_count: data.effect_count ?? session.effectCount(),
      });
      protocol.noteSuccessfulReconcile();
    }

    let checkpointId: string | undefined;
    if (contract.role === "act") {
      // A handler may report that it suppressed a duplicate rather than
      // committing. The boundary honours that only when its own scoped ledger
      // already records the commit; otherwise the handler is asserting an effect
      // the boundary never saw land, and the agent must reconcile instead of
      // being told the work is done.
      const claimsDuplicate = Boolean(data.duplicate_prevented);
      const ledgerCommitted = operationId
        ? session.phaseOf(useCase.id, operationId) === "committed"
        : false;
      if (claimsDuplicate && !ledgerCommitted) {
        const structured_failure = buildStructuredFailure({
          category: "execution_failure",
          tool: toolId,
          expected: "committed_effect_in_boundary_ledger",
          actual: "duplicate_prevented_without_prior_commit",
          owner: "reliability_boundary",
          recoverability: "automatic",
          state_revision: session.currentRevision(),
          operation_id: operationId,
          evidence: ["duplicate_prevented", "boundary_ledger_miss"],
        });
        return refuse({
          protocol,
          session,
          toolId,
          useCase,
          error: "unverified_duplicate_claim",
          structured_failure,
          allowed_next_action: "reconcile",
          next_tool: reconcilerFor(useCase),
          operationId,
          mechanisms: [...mechanisms, "C2", "D2"],
        });
      }

      const duplicate = claimsDuplicate;
      if (!duplicate && operationId) {
        session.recordCommit(
          useCase.id,
          operationId,
          Number(data.revision ?? session.currentRevision() + 1),
        );
      }
      session.syncRevision(Number(data.revision ?? session.currentRevision()));
      if (operationId) {
        session.journal.append({
          at_ms: Date.now(),
          operation_id: operationId,
          intent_fingerprint: intentFingerprint({
            tool: toolId,
            args,
            state_revision: session.currentRevision(),
            contract_version: contract.contract_version,
          }),
          tool: toolId,
          phase: "committed",
          note: duplicate ? "duplicate_prevented" : "committed",
        });
      }
      emit(protocol, "D1", duplicate ? "duplicate_prevented" : "effect_committed", {
        tool: toolId,
        operation_id: operationId ?? null,
        effect_count: session.effectCount(),
      });

      // D2 — a verified, resumable checkpoint for the committed effect.
      const checkpoint = createVerifiedCheckpoint({
        protocol,
        order_state: useCase.committedState,
        order_id: String(data.effect_id ?? data.id ?? ""),
        receipt_id: operationId ?? null,
        state_revision: session.currentRevision(),
        operation_journal_refs: operationId ? [operationId] : [],
        evidence_ids: contract.required_states,
        postconditions_met: true,
      });
      session.addCheckpoint(checkpoint);
      checkpointId = checkpoint.checkpoint_id;
      mechanisms.push("D2");
      emit(protocol, "D2", "checkpoint_bound", {
        tool: toolId,
        checkpoint_id: checkpoint.checkpoint_id,
        order_state: useCase.committedState,
        resumable: true,
      });

      // A committed effect must be verified before any further consequential call.
      protocol.setDecision({
        action: "reconcile",
        reason_code: "effect_committed_verify_before_further_action",
        evidence_refs: [operationId ?? toolId],
      });
      mechanisms.push("C2");
      emit(protocol, "C2", "decision_bound", {
        tool: toolId,
        action: "reconcile",
        single_legal_next_action: reconcilerFor(useCase),
      });
    } else {
      session.syncRevision(Number(data.revision ?? session.currentRevision()));
      protocol.noteSuccessfulObserve();
    }

    return {
      ok: true,
      data: { ...data, contract_version: contract.contract_version },
      effect_count: session.effectCount(),
      allowed_next_action: contract.role === "act" ? "reconcile" : undefined,
      next_tool: contract.role === "act" ? reconcilerFor(useCase) : null,
      mechanisms,
      checkpoint_id: checkpointId,
      simulated: true,
    };
  };
}

function reconcilerFor(useCase: UseCase): string | null {
  const tool = useCase.tools.find((item) => item.role === "reconcile");
  return tool ? `${useCase.id}.${tool.name}` : null;
}
