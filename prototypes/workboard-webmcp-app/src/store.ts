import { beginEffect, markCommitted, markUnknown, type EffectRecord } from "../../reliability-boundary/plugin/api.ts";
import { computeEpoch, checkFreshness, reconcileTransition, validateWorkboardCall, wrapFailure } from "./reliability.ts";
import type { AdversityId, MechanismFlags, ToolName, ToolResult } from "./schemas.ts";

export type Issue = { id: string; title: string; state: string; project_id: string };
export type BoardState = {
  projects: { id: string; name: string }[]; issues: Issue[]; state_revision: number;
  capability_epoch: string; committed_transitions: number;
};

const LS = "workboard-v0";
const TOOLS = ["create_issue", "list_projects", "transition_issue"];

export function defaultBoard(): BoardState {
  return { projects: [{ id: "p1", name: "Alpha" }], issues: [], state_revision: 0,
    capability_epoch: computeEpoch(TOOLS), committed_transitions: 0 };
}

export function loadBoard(): BoardState {
  try {
    if (typeof localStorage === "undefined") return defaultBoard();
    const raw = localStorage.getItem(LS);
    return raw ? { ...defaultBoard(), ...JSON.parse(raw) } as BoardState : defaultBoard();
  } catch { return defaultBoard(); }
}

export function saveBoard(s: BoardState): void {
  try { if (typeof localStorage !== "undefined") localStorage.setItem(LS, JSON.stringify(s)); } catch { /* */ }
}

export type InvokeCtx = { flags: MechanismFlags; adversity: AdversityId; expectedEpoch?: string; effects: Map<string, EffectRecord> };

const fail = (tool: ToolName, err: string, b: BoardState, st: string, f: MechanismFlags, x: Record<string, unknown> = {}): ToolResult =>
  ({ ok: false, error: err, data: { ...wrapFailure(tool, err, st, b.state_revision, f), ...x } });

export function invokeTool(b: BoardState, name: ToolName, args: Record<string, unknown>, ctx: InvokeCtx): ToolResult {
  const issue = b.issues.find((i) => i.id === args.issue_id);
  const st = issue?.state ?? "BACKLOG";
  if (ctx.adversity === "opaque_failure") return fail(name, "opaque_upstream_failure", b, st, ctx.flags);
  const c = validateWorkboardCall(name, args, st, ctx.flags.contract_conformance);
  if (!c.ok) return fail(name, c.error!, b, st, ctx.flags);
  const fr = checkFreshness(name, ctx.expectedEpoch, b.capability_epoch, ctx.flags.capability_freshness);
  if (!fr.ok) return fail(name, fr.error!, b, st, ctx.flags);

  if (name === "list_projects") return { ok: true, data: { projects: b.projects } };
  if (name === "create_issue") {
    const title = String(args.title ?? "");
    if (!title) return fail(name, "title required", b, st, ctx.flags);
    const row = { id: `i${b.issues.length + 1}`, title, state: "BACKLOG", project_id: String(args.project_id ?? "p1") };
    b.issues.push(row); b.state_revision++; saveBoard(b);
    return { ok: true, data: { issue: row } };
  }

  if (name === "transition_issue") {
    const opId = String(args.operation_id ?? "");
    if (ctx.flags.effect_safety && opId) {
      const recon = reconcileTransition(opId, ctx.effects.get(opId) ?? null, b.committed_transitions, issue?.state ?? "BACKLOG", issue?.id ?? null);
      if (recon.action === "reject_duplicate") return fail(name, "duplicate_transition_rejected", b, st, ctx.flags, { reconciliation: recon });
      if (recon.action === "reuse_existing") return { ok: true, data: { issue, reconciliation: recon } };
    }
    if (!issue) return fail(name, "issue_not_found", b, st, ctx.flags);
    const to = String(args.to_state);
    if (to === "DONE" && issue.state !== "IN_REVIEW") return fail(name, "wrong_precondition_state", b, issue.state, ctx.flags);
    let eff: EffectRecord | undefined;
    if (ctx.flags.effect_safety) {
      eff = beginEffect({ operation_id: opId || `op_${Date.now()}`, tool: name, state_revision_before: b.state_revision });
      ctx.effects.set(eff.operation_id, eff);
    }
    issue.state = to;
    if (to === "DONE") b.committed_transitions++;
    b.state_revision++; saveBoard(b);
    if (ctx.adversity === "client_timeout_after_commit" && to === "DONE" && eff) {
      ctx.effects.set(eff.operation_id, markUnknown(eff));
      return fail(name, "transition_timeout_unknown", b, issue.state, ctx.flags, { operation_id: eff.operation_id });
    }
    if (eff) ctx.effects.set(eff.operation_id, markCommitted(eff, issue.id, `rcpt_${issue.id}`));
    return { ok: true, data: { issue, operation_id: eff?.operation_id } };
  }
  return fail(name, "unknown_tool", b, st, ctx.flags);
}

export function bumpCapabilityEpoch(b: BoardState): void {
  b.capability_epoch = computeEpoch(["create_issue", "list_projects"]);
  b.state_revision++; saveBoard(b);
}
