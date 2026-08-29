export type FreshnessDecision = {
  ok: boolean;
  code?: "stale_capability_epoch" | "missing_epoch";
  expected?: string;
  actual?: string;
};

export function computeEpoch(toolNames: string[]): string {
  const normalized = [...toolNames].map((n) => n.trim()).filter(Boolean).sort();
  return `epoch:${normalized.join("|")}`;
}

export function isStale(expected: string | undefined, actual: string | undefined): boolean {
  if (!expected || !actual) return true;
  return expected !== actual;
}

/** Call-time check for consequential tools when freshness flag is on. */
export function rejectStaleConsequential(
  tool: string,
  expectedEpoch: string | undefined,
  actualEpoch: string | undefined,
  consequential: string[] = ["purchase_tickets"],
): FreshnessDecision {
  if (!consequential.includes(tool)) {
    return { ok: true };
  }
  if (!expectedEpoch || !actualEpoch) {
    return { ok: false, code: "missing_epoch", expected: expectedEpoch, actual: actualEpoch };
  }
  if (isStale(expectedEpoch, actualEpoch)) {
    return {
      ok: false,
      code: "stale_capability_epoch",
      expected: expectedEpoch,
      actual: actualEpoch,
    };
  }
  return { ok: true };
}
