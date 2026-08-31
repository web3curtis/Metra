/**
 * D2 — Authoritative checkpoint model for interruption recovery.
 */

import type { ProtocolRunContext } from "../spine/protocolSpine.ts";
import { decideRecovery, type ObservedRuntime, type RecoveryDecision } from "./stateRecovery.ts";

export type CheckpointIntegrity = {
  ok: boolean;
  reason?: string;
};

export type VerifiedCheckpoint = {
  checkpoint_id: string;
  run_id: string;
  attempt_id: string;
  created_at_ms: number;
  expires_at_ms: number;
  document_epoch: string | null;
  session_epoch: string | null;
  state_revision: number;
  order_state: string;
  order_id: string | null;
  receipt_id: string | null;
  operation_journal_refs: string[];
  evidence_ids: string[];
  postconditions_met: boolean;
  integrity_hash: string;
};

export function hashCheckpointPayload(parts: string[]): string {
  // Non-crypto stable fingerprint for prototype integrity checks.
  let h = 0;
  const s = parts.join("|");
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `chk_${h.toString(16)}`;
}

export function createVerifiedCheckpoint(input: {
  protocol: ProtocolRunContext;
  order_state: string;
  order_id: string | null;
  receipt_id: string | null;
  state_revision: number;
  operation_journal_refs?: string[];
  evidence_ids?: string[];
  postconditions_met: boolean;
  ttl_ms?: number;
  now_ms?: number;
}): VerifiedCheckpoint {
  const now = input.now_ms ?? Date.now();
  const checkpoint_id = `cp_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const operation_journal_refs = input.operation_journal_refs ?? [];
  const evidence_ids = input.evidence_ids ?? [];
  const integrity_hash = hashCheckpointPayload([
    input.protocol.identities.run_id,
    input.protocol.identities.attempt_id,
    String(input.state_revision),
    input.order_state,
    input.order_id ?? "",
    input.receipt_id ?? "",
    operation_journal_refs.join(","),
    String(input.postconditions_met),
  ]);
  const cp: VerifiedCheckpoint = {
    checkpoint_id,
    run_id: input.protocol.identities.run_id,
    attempt_id: input.protocol.identities.attempt_id,
    created_at_ms: now,
    expires_at_ms: now + (input.ttl_ms ?? 30 * 60_000),
    document_epoch: input.protocol.identities.document_epoch,
    session_epoch: input.protocol.identities.session_epoch,
    state_revision: input.state_revision,
    order_state: input.order_state,
    order_id: input.order_id,
    receipt_id: input.receipt_id,
    operation_journal_refs,
    evidence_ids,
    postconditions_met: input.postconditions_met,
    integrity_hash,
  };
  input.protocol.record({
    component: "spine",
    stage: "recovery",
    event_type: "checkpoint_created",
    payload: { checkpoint_id, integrity_hash, order_state: input.order_state },
  });
  return cp;
}

export function verifyCheckpointIntegrity(
  checkpoint: VerifiedCheckpoint,
  now_ms = Date.now(),
): CheckpointIntegrity {
  if (now_ms > checkpoint.expires_at_ms) {
    return { ok: false, reason: "expired" };
  }
  const expected = hashCheckpointPayload([
    checkpoint.run_id,
    checkpoint.attempt_id,
    String(checkpoint.state_revision),
    checkpoint.order_state,
    checkpoint.order_id ?? "",
    checkpoint.receipt_id ?? "",
    checkpoint.operation_journal_refs.join(","),
    String(checkpoint.postconditions_met),
  ]);
  if (expected !== checkpoint.integrity_hash) {
    return { ok: false, reason: "integrity_mismatch" };
  }
  if (!checkpoint.postconditions_met && checkpoint.order_state === "PURCHASED") {
    return { ok: false, reason: "postconditions_unmet" };
  }
  return { ok: true };
}

export function recoverFromInterruption(input: {
  protocol: ProtocolRunContext;
  checkpoint: VerifiedCheckpoint | null;
  observed: ObservedRuntime;
  current_document_epoch: string | null;
  current_session_epoch: string | null;
  ambiguous_effect_pending: boolean;
  now_ms?: number;
}): {
  integrity: CheckpointIntegrity;
  decision: RecoveryDecision;
  requires_ab_revalidation: boolean;
} {
  if (input.protocol.recovery_phase === "none") {
    input.protocol.transitionRecovery("interrupted");
  }
  if (input.protocol.recovery_phase === "interrupted") {
    input.protocol.transitionRecovery("reconstructing");
  }

  const integrity = input.checkpoint
    ? verifyCheckpointIntegrity(input.checkpoint, input.now_ms)
    : { ok: false, reason: "missing_checkpoint" };

  if (
    input.checkpoint &&
    ((input.checkpoint.document_epoch &&
      input.current_document_epoch &&
      input.checkpoint.document_epoch !== input.current_document_epoch) ||
      (input.checkpoint.session_epoch &&
        input.current_session_epoch &&
        input.checkpoint.session_epoch !== input.current_session_epoch))
  ) {
    return {
      integrity: { ok: false, reason: "epoch_mismatch" },
      decision: {
        action: "escalate",
        rationale: "Checkpoint epochs disagree with current authority",
        evidence: ["epoch_mismatch"],
      },
      requires_ab_revalidation: true,
    };
  }

  if (input.ambiguous_effect_pending) {
    input.protocol.transitionRecovery("revalidating");
    return {
      integrity,
      decision: {
        action: "escalate",
        rationale: "Ambiguous effect must reconcile before recovery resume",
        evidence: ["ambiguous_effect_pending"],
      },
      requires_ab_revalidation: true,
    };
  }

  if (!integrity.ok) {
    input.protocol.transitionRecovery("terminal_safe");
    return {
      integrity,
      decision: {
        action: "stop",
        rationale: `Checkpoint invalid: ${integrity.reason}`,
        evidence: [integrity.reason ?? "invalid"],
      },
      requires_ab_revalidation: true,
    };
  }

  // A/B revalidation before resume: contract freshness deps + state must still hold.
  input.protocol.transitionRecovery("revalidating");
  input.protocol.record({
    component: "spine",
    stage: "recovery",
    event_type: "ab_revalidate_before_resume",
    payload: {
      checkpoint_id: input.checkpoint?.checkpoint_id ?? null,
      order_state: input.observed.order_state,
      document_epoch: input.current_document_epoch,
      session_epoch: input.current_session_epoch,
      contract_version: input.protocol.identities.contract_version,
    },
  });

  const decision = decideRecovery(input.observed);
  input.protocol.setDecision({
    action:
      decision.action === "resume"
        ? "continue"
        : decision.action === "restart_draft"
          ? "recover"
          : decision.action === "stop"
            ? "stop"
            : "escalate",
    reason_code: decision.action,
    evidence_refs: decision.evidence,
  });
  if (decision.action === "resume") {
    input.protocol.transitionRecovery("resuming");
    input.protocol.transitionRecovery("none");
  } else {
    input.protocol.transitionRecovery("terminal_safe");
  }
  input.protocol.record({
    component: "spine",
    stage: "recovery",
    event_type: "recovery_decision",
    payload: { ...decision, integrity },
  });
  return { integrity, decision, requires_ab_revalidation: true };
}
