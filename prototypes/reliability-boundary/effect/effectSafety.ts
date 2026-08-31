/**
 * D1 — Effect safety: operation IDs, bounded timeout class, duplicate reject,
 * ambiguous-commit reconciliation via receipt/order lookup.
 * Does not implement D2 workflow resume.
 */

export type EffectPhase =
  | "not_started"
  | "in_flight"
  | "committed"
  | "rejected"
  | "unknown";

export type EffectRecord = {
  operation_id: string;
  tool: string;
  phase: EffectPhase;
  started_at_ms: number;
  timeout_ms: number;
  order_id: string | null;
  receipt_id: string | null;
  state_revision_before: number;
};

export type ReconcileResult = {
  ok: boolean;
  action: "reuse_existing" | "safe_to_retry" | "reject_duplicate" | "escalate_unknown";
  operation_id: string;
  order_id: string | null;
  receipt_id: string | null;
  committed_purchase_count: number;
  rationale: string;
};

export function newOperationId(prefix = "op"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function intentFingerprint(input: {
  tool: string;
  args: Record<string, unknown>;
  state_revision: number;
  contract_version?: string;
}): string {
  const keys = Object.keys(input.args).sort();
  const normalized: Record<string, unknown> = {};
  for (const key of keys) normalized[key] = input.args[key];
  const raw = `${input.tool}|${input.contract_version ?? ""}|${input.state_revision}|${JSON.stringify(normalized)}`;
  let h = 0;
  for (let i = 0; i < raw.length; i += 1) h = (h * 33 + raw.charCodeAt(i)) >>> 0;
  return `intent_${h.toString(16)}`;
}

export type EffectJournalEntry = {
  sequence: number;
  at_ms: number;
  operation_id: string;
  intent_fingerprint: string;
  tool: string;
  phase: EffectPhase;
  note?: string;
};

export class EffectJournal {
  private entries: EffectJournalEntry[] = [];
  private sequence = 0;

  append(entry: Omit<EffectJournalEntry, "sequence">): EffectJournalEntry {
    this.sequence += 1;
    const full = { ...entry, sequence: this.sequence };
    this.entries.push(full);
    return full;
  }

  all(): EffectJournalEntry[] {
    return [...this.entries];
  }

  latestFor(operation_id: string): EffectJournalEntry | null {
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      if (this.entries[i]?.operation_id === operation_id) return this.entries[i]!;
    }
    return null;
  }

  conflictOnReuse(input: {
    operation_id: string;
    intent_fingerprint: string;
  }): boolean {
    const prior = this.latestFor(input.operation_id);
    if (!prior) return false;
    return prior.intent_fingerprint !== input.intent_fingerprint;
  }
}

export function beginEffect(input: {
  operation_id: string;
  tool: string;
  state_revision_before: number;
  timeout_ms?: number;
  now_ms?: number;
}): EffectRecord {
  return {
    operation_id: input.operation_id,
    tool: input.tool,
    phase: "in_flight",
    started_at_ms: input.now_ms ?? Date.now(),
    timeout_ms: input.timeout_ms ?? 5_000,
    order_id: null,
    receipt_id: null,
    state_revision_before: input.state_revision_before,
  };
}

export function markCommitted(
  record: EffectRecord,
  orderId: string,
  receiptId: string,
): EffectRecord {
  return {
    ...record,
    phase: "committed",
    order_id: orderId,
    receipt_id: receiptId,
  };
}

export function markRejected(record: EffectRecord): EffectRecord {
  return { ...record, phase: "rejected" };
}

export function markUnknown(record: EffectRecord): EffectRecord {
  return { ...record, phase: "unknown" };
}

export function isTimedOut(record: EffectRecord, now_ms = Date.now()): boolean {
  return record.phase === "in_flight" && now_ms - record.started_at_ms >= record.timeout_ms;
}

/**
 * After timeout / reload ambiguity: inspect observed order state before any retry.
 */
export function reconcileAmbiguousCommit(input: {
  operation_id: string;
  observed: {
    state: string;
    order_id: string | null;
    receipt_id: string | null;
    committed_purchase_count: number;
  };
  prior: EffectRecord | null;
}): ReconcileResult {
  const { observed, operation_id, prior } = input;

  if (observed.committed_purchase_count >= 1 || observed.state === "PURCHASED") {
    if (prior && prior.operation_id !== operation_id && prior.phase === "committed") {
      return {
        ok: false,
        action: "reject_duplicate",
        operation_id,
        order_id: observed.order_id,
        receipt_id: observed.receipt_id,
        committed_purchase_count: observed.committed_purchase_count,
        rationale: "Existing committed purchase; reject second operation_id",
      };
    }
    return {
      ok: true,
      action: "reuse_existing",
      operation_id,
      order_id: observed.order_id,
      receipt_id: observed.receipt_id,
      committed_purchase_count: observed.committed_purchase_count,
      rationale: "Order already purchased; reuse receipt — do not re-purchase",
    };
  }

  if (prior?.phase === "unknown" || prior?.phase === "in_flight") {
    return {
      ok: true,
      action: "safe_to_retry",
      operation_id,
      order_id: null,
      receipt_id: null,
      committed_purchase_count: observed.committed_purchase_count,
      rationale: "No committed purchase observed after ambiguity; safe single retry with same operation_id",
    };
  }

  if (!prior) {
    return {
      ok: false,
      action: "escalate_unknown",
      operation_id,
      order_id: observed.order_id,
      receipt_id: observed.receipt_id,
      committed_purchase_count: observed.committed_purchase_count,
      rationale: "No prior effect record; escalate rather than blind purchase",
    };
  }

  return {
    ok: true,
    action: "safe_to_retry",
    operation_id,
    order_id: null,
    receipt_id: null,
    committed_purchase_count: observed.committed_purchase_count,
    rationale: "Prior effect not committed; retry allowed once under same operation_id",
  };
}

export function rejectDuplicateOperation(input: {
  incoming_operation_id: string;
  committed_operation_ids: string[];
  committed_purchase_count: number;
}): { ok: boolean; code?: string } {
  if (input.committed_purchase_count >= 1) {
    return { ok: false, code: "duplicate_purchase_rejected" };
  }
  if (input.committed_operation_ids.includes(input.incoming_operation_id)) {
    return { ok: false, code: "duplicate_operation_id" };
  }
  return { ok: true };
}
