# Install WebMCP Reliability

Two ways to use this: install the plugin so an agent picks the rules up
automatically, or paste the universal prompt below into any agent that has no
plugin system.

## Prerequisites

- Node 20 or newer.
- A browser with WebMCP (`document.modelContext`) if you want the live lane.
  Without it the demo still runs; the registered-tool audit fails closed rather
  than pretending to pass.

## Option A — install as a plugin

```bash
git clone https://github.com/web3curtis/Metra.git
cd Metra
```

1. Point your agent at the plugin manifest: `.codex-plugin/plugin.json`.
2. Enable the skill: `skills/webmcp-reliability/SKILL.md`.
3. If you are wrapping your own site's tools, import the boundary API from
   `prototypes/reliability-boundary/plugin/api.ts`.

Verify the install against the proofs rather than trusting the manifest:

```bash
cd prototypes/webmcp-test-app
npm ci
npx vitest run          # full suite
npm run build           # tsc --noEmit && vite build
```

Then confirm the two claims that matter:

```bash
npx vitest run tests/liveBoundary.test.ts        # premature call blocked, 0 effects
npx vitest run tests/adversarialBoundary.test.ts # 17 attempts to defeat the boundary
```

If `tests/liveBoundary.test.ts` does not pass, the install is not safe to rely
on. See `docs/BEFORE_AFTER_EVIDENCE.md` for what those tests prove.

## Option B — run the demo

```bash
cd prototypes/webmcp-test-app && npm install && npm run dev
```

Live version: https://web3curtis.github.io/Metra/

## Option C — universal agent prompt

Paste this into any agent that calls WebMCP tools. It carries no dependency on
this repository.

```text
You are calling WebMCP tools exposed by a web page (document.modelContext).
Some tools are consequential: they create, submit, pay, delete or transition
real state. Follow these rules for every consequential call.

1. OBSERVE BEFORE ACTING.
   Never make a consequential call as your first action on a workflow. First
   read the state you are about to change, and read whatever the tool's own
   description says must be true. If you cannot name the evidence that makes
   the action correct, you are not ready to act.

2. BIND AN OPERATION ID.
   Send a stable operation_id you generate, plus the state revision you just
   observed. Reuse the same operation_id for the same intent. Never invent a
   second id for the same goal.

3. TREAT AMBIGUITY AS COMMITTED.
   If a consequential call times out, throws, or returns anything you cannot
   interpret, assume the effect MAY have landed. Do not retry. Reconcile:
   re-read authoritative state by operation_id and find out. Only then decide.

4. NEVER BLIND-RETRY.
   On failure, read the failure's category and act on it:
     - missing or unmet precondition  -> go observe the named evidence
     - stale state or revision        -> re-observe, then re-decide
     - ambiguous or possible commit   -> reconcile by operation_id
     - malformed or contract failure  -> stop; do not repair by repeating
   A failure that offers a single legal next action is telling you the only
   safe move. Take that one.

5. DISTRUST SUCCESS THAT PROVES NOTHING.
   A response of ok/true with no identifier, no revision and no record is not
   a success. Treat it as ambiguous and reconcile.

6. STALE EVIDENCE IS NOT EVIDENCE.
   If state changed after you observed it, your observation is void. Re-observe
   before acting, even if you already had permission a moment ago.

7. ONE EFFECT, THEN VERIFY.
   After a consequential call appears to succeed, verify it before any further
   consequential call. Exactly one commit per intent.

8. AFTER A RELOAD, RE-OBSERVE.
   Following navigation or reload, re-read the tool list, the state and any
   receipts. A URL is not proof that work completed.

9. STOP HONESTLY.
   If you cannot proceed safely, stop and report: what you were trying to do,
   what the last authoritative state was, what completed, what did not, and
   the next safe step. Never fabricate completion.
```

## What the rules map to

| Prompt rule | Mechanism | Implementation |
| --- | --- | --- |
| Observe before acting | A, B | `contract/`, `freshness/` |
| Bind an operation id | D1 | `effect/effectSafety.ts` |
| Treat ambiguity as committed | C1, D1 | `semantics/normalizeOutcome.ts` |
| Never blind-retry | C2 | `diagnosis/diagnosisPolicy.ts` |
| Distrust empty success | C1 | `semantics/` postcondition checks |
| Stale evidence is not evidence | B | `freshness/capabilityFreshness.ts` |
| One effect, then verify | D1, D2 | `effect/`, `recovery/checkpoint.ts` |
| After reload, re-observe | D2 | `recovery/stateRecovery.ts` |

## Scope

Purchases and tickets in this repository are **simulated**. There are no
payments and no real external effects. Point the agent at sandboxed or simulated
tools first, and report gaps as feedback.
