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
import { recoveryPolicySupports } from "../../../reliability-boundary/recovery/stateRecovery.ts";
import { COMMITTED_EFFECT_STATES, type LabTool, type UseCase } from "../lab/catalog.ts";
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
  /** Effects the boundary has confirmed against authority. Never a handler claim. */
  effect_count: number;
  /** Present when authority and the boundary mirror could disagree. */
  authoritative_effect_count?: number | null;
  boundary_claimed_effect_count?: number;
  commit_status?: "none" | "committed" | "possible" | "rejected";
  authority?: "authoritative" | "client_only" | "unavailable";
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
 * Boundary state shared by every tool registered in one session. Mirrors only what
 * the boundary observes through registered calls, so it stays truthful even if the
 * domain runtime is swapped out.
 */
export class BoundarySession {
  readonly journal = new EffectJournal();
  private readonly observations = new Map<string, Map<string, ObservationMirror>>();
  /** Keyed by tool and operation id, never by a raw operation id. */
  private readonly committed = new Map<string, EffectPhase>();
  /** Which tool and intent first claimed an operation id, so it cannot be reused. */
  private readonly operationOwners = new Map<string, { tool_id: string; intent_fingerprint: string }>();
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

  private static key(toolId: string, operationId: string): string {
    return `${toolId}::${operationId}`;
  }

  phaseOf(toolId: string, operationId: string): EffectPhase {
    return this.committed.get(BoundarySession.key(toolId, operationId)) ?? "not_started";
  }

  /** Confirmed effects this tool has produced in this session. */
  effectsBy(toolId: string): number {
    let total = 0;
    for (const [key, phase] of this.committed) {
      if (phase === "committed" && key.startsWith(`${toolId}::`)) total += 1;
    }
    return total;
  }

  /**
   * Binds an operation id to the first tool and intent that used it. A later call
   * that reuses the id for anything else is refused rather than allowed to inherit
   * another tool's committed record.
   */
  claimOperation(input: {
    tool_id: string;
    operation_id: string;
    intent_fingerprint: string;
  }): { ok: true } | { ok: false; reason: string; owner: { tool_id: string; intent_fingerprint: string } } {
    const owner = this.operationOwners.get(input.operation_id);
    if (!owner) {
      this.operationOwners.set(input.operation_id, {
        tool_id: input.tool_id,
        intent_fingerprint: input.intent_fingerprint,
      });
      return { ok: true };
    }
    if (owner.tool_id !== input.tool_id) {
      return { ok: false, reason: "operation_id_bound_to_other_tool", owner };
    }
    if (owner.intent_fingerprint !== input.intent_fingerprint) {
      return { ok: false, reason: "operation_id_reused_for_different_intent", owner };
    }
    return { ok: true };
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

  /**
   * Records a commit the boundary has confirmed against authority. Safe to call
   * again for the same tool and operation id; the mirror never double-counts.
   */
  recordCommit(toolId: string, operationId: string, revisionAfter: number): boolean {
    const key = BoundarySession.key(toolId, operationId);
    if (this.committed.get(key) === "committed") return false;
    this.committed.set(key, "committed");
    this.effects += 1;
    if (Number.isInteger(revisionAfter) && revisionAfter > this.revision) this.revision = revisionAfter;
    return true;
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
    postconditions_met: false,
    // A refusal checkpoint records where the run stopped. Recovery has no policy
    // for resuming from a blocked state, so it must not be advertised as resumable.
    resumable: recoveryPolicySupports(checkpoint.order_state, COMMITTED_EFFECT_STATES),
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
    // JSON Schema counts characters, not UTF-16 code units, so an emoji is one.
    if (spec.minLength !== undefined && Array.from(value).length < spec.minLength) {
      return { ok: false, detail: `${key}_below_min_length` };
    }
  }

  // The registered schema is what the caller was shown, so it is what binds.
  // A read-only tool that declares no properties must still reject extra ones.
  if (inputSchema.additionalProperties === false || contract.shape.unknown_field_policy === "reject") {
    const declared = Object.keys(properties);
    const allowed = new Set(declared.length > 0 ? declared : contract.shape.required_args);
    for (const key of Object.keys(args)) {
      if (!allowed.has(key)) return { ok: false, detail: `unknown_field_${key}` };
    }
  }
  return { ok: true };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/**
 * Confirms a consequential response against authoritative state.
 *
 * A handler saying "committed" is a claim, not a fact. The boundary only counts
 * an effect once an independent reconcile-by-operation-id agrees, so a handler
 * that reports success without mutating anything cannot produce a committed
 * effect count or a verified checkpoint.
 */
type Confirmation = {
  confirmed: boolean;
  reason: string;
  authoritative_effect_count: number | null;
  authoritative_revision: number | null;
  authoritative_effect_id: string | null;
  /** Authority's own record, used verbatim in the envelope a caller receives. */
  authoritative_record: Record<string, unknown> | null;
};

function unconfirmed(reason: string, partial: Partial<Confirmation> = {}): Confirmation {
  return {
    confirmed: false,
    reason,
    authoritative_effect_count: partial.authoritative_effect_count ?? null,
    authoritative_revision: partial.authoritative_revision ?? null,
    authoritative_effect_id: partial.authoritative_effect_id ?? null,
    authoritative_record: null,
  };
}

/**
 * What authority said about one operation id, after validation.
 *
 * There are exactly two answers authority is allowed to give, and both must be
 * complete. Anything partial, self-contradictory, or merely implied is `unknown`,
 * because a half-formed answer is indistinguishable from a wrong one.
 */
type AuthorityReading =
  | {
      kind: "committed";
      record: Record<string, unknown>;
      effect: Record<string, unknown>;
      effect_id: string;
      revision: number;
      effect_count: number;
    }
  | { kind: "absent"; revision: number | null; effect_count: number }
  | { kind: "unknown"; reason: string; revision: number | null; effect_count: number | null };

function unknownReading(reason: string, revision: number | null = null, count: number | null = null): AuthorityReading {
  return { kind: "unknown", reason, revision, effect_count: count };
}

function readAuthority(
  verify: ((operationId: string) => unknown) | undefined,
  operationId: string | undefined,
): AuthorityReading {
  if (!operationId) return unknownReading("no_operation_id");
  if (!verify) return unknownReading("no_authority_available");

  // A reconcile that throws is an authority we could not reach, not a rejection.
  let raw: Record<string, unknown> | null;
  try {
    raw = asRecord(verify(operationId));
  } catch {
    return unknownReading("authority_threw");
  }

  const data = asRecord(raw?.data);
  if (!raw || raw.ok !== true || !data) return unknownReading("authority_unreachable");
  if (data.authority !== "authoritative") return unknownReading("authority_unavailable");

  const rawRevision = Number(data.revision);
  const revision = Number.isInteger(rawRevision) ? rawRevision : null;
  const rawCount = Number(data.effect_count);
  const count = Number.isInteger(rawCount) ? rawCount : null;

  const effect = asRecord(data.effect);
  const record = asRecord(data.record);

  if (data.resolution === "absent") {
    // Absence must be unambiguous: an "absent" answer carrying a record is broken.
    if (effect || record) return unknownReading("absent_answer_carries_record", revision, count);
    if (count === null || count < 0) return unknownReading("absent_answer_without_count", revision, count);
    return { kind: "absent", revision, effect_count: count };
  }

  if (data.resolution !== "committed") {
    return unknownReading(`unrecognized_resolution:${String(data.resolution)}`, revision, count);
  }

  if (!effect || !record) return unknownReading("committed_answer_without_record", revision, count);
  if (effect.status !== "committed") return unknownReading("committed_answer_not_committed", revision, count);
  if (data.operation_id !== operationId || effect.operation_id !== operationId) {
    return unknownReading("operation_id_mismatch", revision, count);
  }
  const effectId = String(data.effect_id ?? effect.id ?? "");
  if (!effectId) return unknownReading("committed_answer_without_effect_id", revision, count);
  if (revision === null) return unknownReading("committed_answer_without_revision", revision, count);
  if (count === null || count < 1) return unknownReading("committed_answer_without_count", revision, count);

  return { kind: "committed", record, effect, effect_id: effectId, revision, effect_count: count };
}

/**
 * Whether an authoritative record is the kind of thing this use case produces,
 * so one operation id cannot pass a commerce order off as a travel reservation.
 */
function recordMatchesUseCase(
  record: Record<string, unknown>,
  useCase: UseCase,
  contract: SuiteToolContract,
): { ok: true } | { ok: false; reason: string } {
  const expected = useCase.effectRecord;
  if (record.record_type !== expected.record_type) return { ok: false, reason: "record_type_mismatch" };
  for (const [field, value] of Object.entries(expected)) {
    if (field === "record_type") continue;
    if (record[field] !== value) return { ok: false, reason: `record_field_mismatch:${field}` };
  }
  const envelopeFields = new Set(["operation_id", "effect_id", "revision"]);
  for (const field of contract.postconditions) {
    if (envelopeFields.has(field)) continue;
    if (record[field] === undefined) return { ok: false, reason: `authoritative_postcondition_missing:${field}` };
  }
  return { ok: true };
}

function confirmEffect(input: {
  verify: ((operationId: string) => unknown) | undefined;
  operationId: string | undefined;
  useCase: UseCase;
  contract: SuiteToolContract;
  /** The full provisional claim the handler made, envelope merged with record. */
  claim: Record<string, unknown>;
}): Confirmation {
  if (!input.operationId) return unconfirmed("no_operation_id");
  if (!input.verify) return unconfirmed("no_authority_available");

  // The claim must at least be about the operation the caller asked for, and must
  // carry a revision of the declared type rather than something merely truthy.
  if (input.claim.operation_id !== undefined && input.claim.operation_id !== input.operationId) {
    return unconfirmed("claimed_operation_id_mismatch");
  }
  if (input.claim.revision !== undefined && !Number.isInteger(input.claim.revision)) {
    return unconfirmed("claimed_revision_not_integer");
  }

  const reading = readAuthority(input.verify, input.operationId);
  if (reading.kind !== "committed") {
    return unconfirmed(
      reading.kind === "absent" ? "authority_says_absent" : reading.reason,
      { authoritative_effect_count: reading.effect_count, authoritative_revision: reading.revision },
    );
  }

  const carry = {
    authoritative_effect_count: reading.effect_count,
    authoritative_revision: reading.revision,
    authoritative_effect_id: reading.effect_id,
  };

  const claimedEffectId = input.claim.effect_id;
  if (claimedEffectId !== undefined && reading.effect_id !== String(claimedEffectId)) {
    return unconfirmed("effect_id_mismatch", carry);
  }

  const semantics = recordMatchesUseCase(reading.record, input.useCase, input.contract);
  if (!semantics.ok) return unconfirmed(semantics.reason, carry);

  // Where the claim states a domain field, authority must state the same value.
  const envelopeFields = new Set(["operation_id", "effect_id", "revision"]);
  for (const field of input.contract.postconditions) {
    if (envelopeFields.has(field)) continue;
    if (input.claim[field] !== undefined && reading.record[field] !== input.claim[field]) {
      return unconfirmed(`postcondition_disagreement:${field}`, carry);
    }
  }

  const claimedCount = Number(input.claim.effect_count);
  if (Number.isInteger(claimedCount) && claimedCount !== reading.effect_count) {
    return unconfirmed("effect_count_disagreement", carry);
  }

  const claimedRevision = Number(input.claim.revision);
  if (Number.isInteger(claimedRevision) && claimedRevision !== reading.revision) {
    return unconfirmed("revision_disagreement", carry);
  }

  return {
    confirmed: true,
    reason: "authoritative_match",
    authoritative_effect_count: reading.effect_count,
    authoritative_revision: reading.revision,
    authoritative_effect_id: reading.effect_id,
    authoritative_record: reading.record,
  };
}

type AuthorityProbe = {
  resolution: "committed" | "absent" | "unknown";
  effect_count: number | null;
  revision: number | null;
  effect_id: string | null;
};

/**
 * Asks authority what happened to one operation id after a call failed.
 *
 * Uses the same strict reading as a success path, so the two cannot drift: an
 * incomplete answer is unknown in both, and a committed answer must describe a
 * record this use case could actually have produced.
 */
function probeAuthority(
  verify: ((operationId: string) => unknown) | undefined,
  operationId: string | undefined,
  useCase: UseCase,
  contract: SuiteToolContract,
): AuthorityProbe {
  const reading = readAuthority(verify, operationId);

  switch (reading.kind) {
    case "committed": {
      const semantics = recordMatchesUseCase(reading.record, useCase, contract);
      if (!semantics.ok) {
        return { resolution: "unknown", effect_count: null, revision: null, effect_id: null };
      }
      return {
        resolution: "committed",
        effect_count: reading.effect_count,
        revision: reading.revision,
        effect_id: reading.effect_id,
      };
    }
    case "absent":
      return { resolution: "absent", effect_count: reading.effect_count, revision: reading.revision, effect_id: null };
    case "unknown":
      return { resolution: "unknown", effect_count: reading.effect_count, revision: reading.revision, effect_id: null };
    default: {
      const _exhaustive: never = reading;
      return _exhaustive;
    }
  }
}

/**
 * C1 + C2 + D2 for a consequential call that failed after dispatch.
 *
 * Three honest outcomes: authority found the effect (it committed despite the
 * error), authority proved there is none (safe to observe and try again), or
 * authority could not say (ambiguous — reconcile, never retry).
 */
function resolveFailedAct(input: {
  protocol: ProtocolRunContext;
  session: BoundarySession;
  useCase: UseCase;
  contract: SuiteToolContract;
  toolId: string;
  operationId: string | undefined;
  verify: ((operationId: string) => unknown) | undefined;
  handlerError: string;
  normalized: NormalizedOutcome;
  mechanisms: Mechanism[];
}): BoundaryEnvelope {
  const probe = probeAuthority(input.verify, input.operationId, input.useCase, input.contract);
  emit(input.protocol, "D1", "failed_act_resolved", {
    tool: input.toolId,
    operation_id: input.operationId ?? null,
    handler_error: input.handlerError,
    resolution: probe.resolution,
    authoritative_effect_count: probe.effect_count,
  });

  if (probe.resolution === "committed" && input.operationId) {
    // The call reported failure but the effect is real. Recording it is the only
    // way the run stops believing it still has work to do.
    input.session.recordCommit(input.toolId, input.operationId, probe.revision ?? input.session.currentRevision());
    const structured_failure = buildStructuredFailure({
      category: "ambiguous_effect",
      tool: input.toolId,
      expected: "matching_response_and_effect",
      actual: `error_reported_but_effect_committed:${input.handlerError}`,
      owner: "reliability_boundary",
      recoverability: "manager",
      state_revision: input.session.currentRevision(),
      operation_id: input.operationId,
      evidence: ["failed_act_resolved", "authoritative_commit"],
    });
    const refusal = refuse({
      protocol: input.protocol,
      session: input.session,
      toolId: input.toolId,
      useCase: input.useCase,
      error: "effect_committed_despite_error",
      structured_failure,
      allowed_next_action: "stop",
      next_tool: null,
      operationId: input.operationId,
      mechanisms: [...input.mechanisms, "C1", "C2", "D2"],
    });
    return {
      ...refusal,
      commit_status: "committed",
      authority: "authoritative",
      authoritative_effect_count: probe.effect_count,
    };
  }

  if (probe.resolution === "absent") {
    // Authority proved no effect exists, so the ordinary recovery route is open.
    const stale = input.handlerError === "stale_revision";
    return {
      ...refuse({
        protocol: input.protocol,
        session: input.session,
        toolId: input.toolId,
        useCase: input.useCase,
        error: input.handlerError,
        structured_failure:
          input.normalized.structured_failure ??
          buildStructuredFailure({
            category: stale ? "stale_capability_or_state" : "execution_failure",
            tool: input.toolId,
            expected: "ok",
            actual: input.handlerError,
            owner: "reliability_boundary",
            recoverability: "automatic",
            state_revision: input.session.currentRevision(),
            operation_id: input.operationId,
          }),
        allowed_next_action: stale ? "reobserve" : "observe",
        next_tool: producerOf(input.useCase.id, input.contract.required_states[0] ?? ""),
        operationId: input.operationId,
        mechanisms: [...input.mechanisms, "C1", "C2", "D2"],
      }),
      commit_status: "rejected",
      authority: "authoritative",
      authoritative_effect_count: probe.effect_count,
    };
  }

  const structured_failure = buildStructuredFailure({
    category: "ambiguous_effect",
    tool: input.toolId,
    expected: "authoritative_answer_about_operation",
    actual: `unresolved_after:${input.handlerError}`,
    owner: "reliability_boundary",
    recoverability: "manager",
    state_revision: input.session.currentRevision(),
    operation_id: input.operationId,
    evidence: ["failed_act_resolved", "authority_unreachable"],
  });
  return {
    ...refuse({
      protocol: input.protocol,
      session: input.session,
      toolId: input.toolId,
      useCase: input.useCase,
      error: "ambiguous_effect",
      structured_failure,
      allowed_next_action: "reconcile",
      next_tool: reconcilerFor(input.useCase),
      operationId: input.operationId,
      mechanisms: [...input.mechanisms, "C1", "C2", "D2"],
    }),
    commit_status: "possible",
    authority: "unavailable",
  };
}

/**
 * The refusal a caller receives when the protocol decision gate blocks dispatch.
 * Same envelope shape as every other refusal, including the single legal next move.
 */
export function describeDecisionBlock(input: {
  useCase: UseCase;
  tool: LabTool;
  session: BoundarySession;
  protocol: ProtocolRunContext;
  code: string;
  action: string;
}): BoundaryEnvelope {
  const toolId = `${input.useCase.id}.${input.tool.name}`;
  const nextTool = input.code === "decision_requires_reobserve" ? null : reconcilerFor(input.useCase);
  const allowed_next_action: NextAction =
    input.code === "decision_requires_reobserve"
      ? "reobserve"
      : input.action === "escalate" || input.action === "stop"
        ? "stop"
        : "reconcile";

  const structured_failure = buildStructuredFailure({
    category: "ambiguous_effect",
    tool: toolId,
    expected: "resolved_prior_effect",
    actual: input.code,
    owner: "reliability_boundary",
    recoverability: allowed_next_action === "stop" ? "manager" : "automatic",
    state_revision: input.session.currentRevision(),
    operation_id: input.protocol.identities.operation_id ?? undefined,
    evidence: ["decision_gate", input.code, input.action],
  });

  emit(input.protocol, "C2", "decision_block_reported", {
    tool: toolId,
    code: input.code,
    action: input.action,
    single_legal_next_action: nextTool,
  });

  return {
    ok: false,
    error: input.code,
    category: structured_failure.category,
    data: { decision_action: input.action, tool: toolId },
    allowed_next_action,
    next_tool: nextTool,
    effect_count: input.session.effectCount(),
    commit_status: "rejected",
    structured_failure,
    mechanisms: ["C2"],
    simulated: true,
  };
}

export function createEnforcedHandler(input: {
  useCase: UseCase;
  tool: LabTool;
  session: BoundarySession;
  protocol: ProtocolRunContext;
  handler: (args: Record<string, unknown>) => unknown;
  /** Reads authoritative state for one operation id. Omitted for reconcile tools. */
  verify?: (operationId: string) => unknown;
}): (args: Record<string, unknown>) => BoundaryEnvelope {
  const { useCase, tool, session, protocol, handler, verify } = input;
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
      // Intent is what the caller asked for, so the fingerprint is taken from the
      // declared arguments. Folding in the session's ambient revision would make a
      // byte-identical retry look like a new intent, which is the opposite of what
      // an idempotency key is for.
      const fingerprint = intentFingerprint({
        tool: toolId,
        args,
        state_revision: Number.isInteger(args.expected_revision)
          ? (args.expected_revision as number)
          : session.currentRevision(),
        contract_version: contract.contract_version,
      });
      const ownership = session.claimOperation({
        tool_id: toolId,
        operation_id: operationId,
        intent_fingerprint: fingerprint,
      });
      session.journal.append({
        at_ms: Date.now(),
        operation_id: operationId,
        intent_fingerprint: fingerprint,
        tool: toolId,
        phase: session.phaseOf(toolId, operationId),
        note: ownership.ok ? "intent_recorded" : ownership.reason,
      });
      emit(protocol, "D1", "effect_identity_bound", {
        tool: toolId,
        operation_id: operationId,
        intent_fingerprint: fingerprint,
        prior_phase: session.phaseOf(toolId, operationId),
        identity_conflict: ownership.ok ? null : ownership.reason,
      });

      // An operation id that already means something else is refused outright.
      // Inheriting another tool's record would let one commit certify a second.
      if (!ownership.ok && contract.role === "act") {
        const structured_failure = buildStructuredFailure({
          category: "invalid_input_or_precondition",
          tool: toolId,
          expected: "unused_operation_id_for_this_intent",
          actual: ownership.reason,
          owner: "reliability_boundary",
          recoverability: "manager",
          state_revision: session.currentRevision(),
          operation_id: operationId,
          evidence: ["effect_identity_bound", ownership.reason, ownership.owner.tool_id],
        });
        return refuse({
          protocol,
          session,
          toolId,
          useCase,
          error: "operation_id_conflict",
          structured_failure,
          allowed_next_action: "stop",
          next_tool: null,
          operationId,
          mechanisms: [...mechanisms, "C1", "C2", "D2"],
        });
      }

      if (contract.role === "act" && session.phaseOf(toolId, operationId) === "committed") {
        emit(protocol, "D1", "duplicate_suppressed_by_operation_id", {
          tool: toolId,
          operation_id: operationId,
        });
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

      const alreadyCommitted = operationId ? session.phaseOf(toolId, operationId) === "committed" : false;
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

      // Evidence is current, so this is the last thing standing between the caller
      // and a second effect. The budget is declared per tool, which is why the run
      // can say "the task is finished" rather than "observe again".
      if (
        contract.effect_budget !== null &&
        session.effectsBy(toolId) >= contract.effect_budget &&
        (!operationId || session.phaseOf(toolId, operationId) !== "committed")
      ) {
        emit(protocol, "D1", "effect_budget_exhausted", {
          tool: toolId,
          effect_budget: contract.effect_budget,
          confirmed_effects: session.effectsBy(toolId),
        });
        const structured_failure = buildStructuredFailure({
          category: "invalid_input_or_precondition",
          tool: toolId,
          expected: `at_most_${contract.effect_budget}_effects`,
          actual: `already_committed_${session.effectsBy(toolId)}`,
          owner: "reliability_boundary",
          recoverability: "manager",
          state_revision: session.currentRevision(),
          operation_id: operationId,
          evidence: ["effect_budget_exhausted", toolId],
        });
        return refuse({
          protocol,
          session,
          toolId,
          useCase,
          error: "effect_budget_exhausted",
          structured_failure,
          allowed_next_action: "stop",
          next_tool: null,
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
      // A consequential call that was dispatched and came back unhappy has not
      // proved anything about the world. Only authority can say whether the effect
      // exists, so the failure is resolved against authority before it is reported.
      if (contract.role === "act") {
        return resolveFailedAct({
          protocol,
          session,
          useCase,
          contract,
          toolId,
          operationId,
          verify,
          handlerError: String(record?.error ?? "execution_failure"),
          normalized,
          mechanisms,
        });
      }
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
        allowed_next_action: "stop",
        next_tool: null,
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
      // Reconciliation is how an unmirrored commit becomes known. If authority
      // holds a committed record we never counted, adopt it now rather than keep
      // reporting a lower count than the world actually contains.
      const authoritativeEffect = asRecord(data.effect);
      const actToolId = actToolIdFor(useCase);
      if (
        operationId &&
        actToolId &&
        data.authority === "authoritative" &&
        authoritativeEffect?.status === "committed" &&
        authoritativeEffect.operation_id === operationId &&
        session.phaseOf(actToolId, operationId) !== "committed"
      ) {
        session.recordCommit(actToolId, operationId, Number(data.revision ?? session.currentRevision()));
        emit(protocol, "D1", "discovered_commit_adopted", {
          tool: toolId,
          operation_id: operationId,
          adopted_for: actToolId,
          effect_count: session.effectCount(),
        });
      }
      emit(protocol, "D1", "effect_reconciled", {
        tool: toolId,
        operation_id: operationId ?? null,
        authority: data.authority ?? "unavailable",
        effect_count: data.effect_count ?? session.effectCount(),
      });
      // Only an authoritative answer discharges the obligation to verify.
      if (data.authority === "authoritative") protocol.noteSuccessfulReconcile();
    }

    let checkpointId: string | undefined;
    /** Set for a confirmed commit, so the caller reads authority and not the claim. */
    let verifiedData: Record<string, unknown> | null = null;
    let confirmedCount: number | null = null;
    if (contract.role === "act") {
      const duplicate = Boolean(data.duplicate_prevented);

      // The handler's success is provisional until authority agrees on the whole
      // tuple: identity, committed status, record semantics, revision and count.
      const confirmation = confirmEffect({
        verify,
        operationId,
        useCase,
        contract,
        claim: visible,
      });
      emit(protocol, "D1", "effect_confirmation", {
        tool: toolId,
        operation_id: operationId ?? null,
        confirmed: confirmation.confirmed,
        reason: confirmation.reason,
        claimed_effect_count: data.effect_count ?? null,
        authoritative_effect_count: confirmation.authoritative_effect_count,
        authoritative_revision: confirmation.authoritative_revision,
      });

      if (!confirmation.confirmed) {
        const structured_failure = buildStructuredFailure({
          category: "ambiguous_effect",
          tool: toolId,
          expected: "authoritative_record_for_operation_id",
          actual: confirmation.reason,
          owner: "reliability_boundary",
          recoverability: "manager",
          state_revision: session.currentRevision(),
          operation_id: operationId,
          evidence: ["effect_confirmation", confirmation.reason],
        });
        const refusal = refuse({
          protocol,
          session,
          toolId,
          useCase,
          error: "unverified_effect",
          structured_failure,
          allowed_next_action: "reconcile",
          next_tool: reconcilerFor(useCase),
          operationId,
          mechanisms: [...mechanisms, "C2", "D2"],
        });
        return {
          ...refusal,
          commit_status: "possible",
          authority: "unavailable",
          authoritative_effect_count: confirmation.authoritative_effect_count,
          boundary_claimed_effect_count: session.effectCount(),
        };
      }

      // What the caller is told about a commit is authority's account of it. The
      // handler's own payload is never forwarded, so a handler cannot describe an
      // effect differently from the record that was actually verified.
      confirmedCount = confirmation.authoritative_effect_count;
      verifiedData = {
        operation_id: operationId,
        effect_id: confirmation.authoritative_effect_id,
        revision: confirmation.authoritative_revision,
        effect_count: confirmation.authoritative_effect_count,
        record: confirmation.authoritative_record,
        ...(confirmation.authoritative_record ?? {}),
        duplicate_prevented: duplicate,
        simulated: true,
      };

      // Adoption is driven by authority, not by whether the handler called this a
      // duplicate: reconciliation may have just revealed a commit we never mirrored.
      if (operationId) {
        const adopted = session.recordCommit(
          toolId,
          operationId,
          confirmation.authoritative_revision ?? Number(data.revision ?? session.currentRevision() + 1),
        );
        if (adopted && duplicate) {
          emit(protocol, "D1", "discovered_commit_adopted", {
            tool: toolId,
            operation_id: operationId,
            authoritative_effect_count: confirmation.authoritative_effect_count,
          });
        }
      }
      session.syncRevision(confirmation.authoritative_revision ?? Number(data.revision ?? session.currentRevision()));
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
        order_id: confirmation.authoritative_effect_id ?? "",
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
        // Only claimed when the recovery policy can actually decide from this state.
        resumable: recoveryPolicySupports(useCase.committedState, COMMITTED_EFFECT_STATES),
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

    // Both a commit and a reconcile know what authority counted. Reporting the
    // mirror's number instead would contradict the world the caller is acting in.
    const authoritativeCount =
      confirmedCount ??
      (contract.role === "reconcile" && Number.isInteger(Number(data.effect_count))
        ? Number(data.effect_count)
        : null);

    return {
      ok: true,
      data: { ...(verifiedData ?? data), contract_version: contract.contract_version },
      effect_count: authoritativeCount ?? session.effectCount(),
      authoritative_effect_count: authoritativeCount,
      boundary_claimed_effect_count:
        authoritativeCount !== null && authoritativeCount !== session.effectCount()
          ? session.effectCount()
          : undefined,
      commit_status: contract.role === "act" ? "committed" : undefined,
      authority: contract.role === "reconcile" ? (data.authority as BoundaryEnvelope["authority"]) : undefined,
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

function actToolIdFor(useCase: UseCase): string | null {
  const tool = useCase.tools.find((item) => item.role === "act");
  return tool ? `${useCase.id}.${tool.name}` : null;
}
