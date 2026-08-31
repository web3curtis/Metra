# Before and after: a premature consequential call

This is the reproducible evidence behind the enforcement change. Both columns
run the **same call** through the **same registered WebMCP path**
(`document.modelContext.registerTool` then `execute`). Nothing here calls the
domain runtime directly, because the question is what an agent can actually do.

## The call

```js
support.create_support_ticket({
  operation_id: "codex-premature-001",
  expected_revision: 1
})
```

Invoked with **no prior observations**. The support workflow declares that a
ticket may only be created after a current `support.search_help` and
`support.get_customer_context`.

## Before — commit `e96ab8f`

```json
{
  "ok": true,
  "data": {
    "id": "support_1",
    "status": "committed",
    "operation_id": "codex-premature-001",
    "revision": 2,
    "effect_count": 1,
    "simulated": true
  }
}
```

The ticket was created. Three further problems follow from the same gap:

1. A **second** premature call with a different `operation_id` also returned
   `ok: true`, so an agent could accumulate effects having observed nothing.
2. Reconciliation returned a generic read payload
   (`{ use_case, object, revision, effect: { id, status } }`) rather than the
   authoritative ticket record, so an ambiguous commit could not be settled from
   evidence.
3. The ordering requirement existed only as catalog prose, so it could not fail.

## After — commit `121c4b5`

```json
{
  "ok": false,
  "error": "invalid_precondition",
  "category": "invalid_input_or_precondition",
  "missing_evidence": ["support.verified_help", "support.customer_context"],
  "stale_evidence": [],
  "allowed_next_action": "observe",
  "next_tool": "support.search_help",
  "effect_count": 0,
  "structured_failure": {
    "category": "invalid_input_or_precondition",
    "tool": "support.create_support_ticket",
    "expected": "support.verified_help+support.customer_context",
    "actual": "missing:support.verified_help,support.customer_context",
    "owner": "reliability_boundary",
    "recoverability": "automatic",
    "state_revision": 1,
    "operation_id": "codex-premature-001",
    "evidence": ["required_states", "support.verified_help", "support.customer_context"]
  },
  "mechanisms": ["A", "D1", "B", "C1", "C2", "D2"],
  "simulated": true
}
```

Zero effects. Both missing observations are named. Exactly one legal next action
is offered, and it points at the tool that produces the first missing
observation. An instrumented spy confirms the domain handler is **never
invoked** — the refusal happens before dispatch, so it still holds if the domain
handler is replaced.

## Reproduce the "after" column

```bash
git clone https://github.com/web3curtis/Metra.git
cd Metra/prototypes/webmcp-test-app
npm ci
npx vitest run tests/liveBoundary.test.ts      # F0-F7, the falsifier
npx vitest run tests/adversarialBoundary.test.ts   # 17 attack attempts
npx vitest run                                  # full suite
npm run build
```

## Reproduce the "before" column

```bash
git clone https://github.com/web3curtis/Metra.git before-state
cd before-state
git checkout e96ab8f -- prototypes/webmcp-test-app/src prototypes/reliability-boundary
```

Then register the suite and invoke the call above. At `e96ab8f`,
`SuiteToolRuntime` exposes only `constructor, reset, execute`; there is no
effect ledger to interrogate, which is itself part of the finding.

## What the boundary refuses, in one table

| Attempt | Result | Effects |
| --- | --- | --- |
| Act with no observations | `invalid_precondition` | 0 |
| Act with one of two observations | `invalid_precondition`, names the missing one | 0 |
| Act with another use case's observations | `invalid_precondition` | 0 |
| Act with an unknown extra argument | `contract_violation` | 0 |
| Act with `expected_revision: "1"` (string) | `contract_violation` | 0 |
| Act with a non-string `operation_id` | `contract_violation` | 0 |
| Replay the same `operation_id` three times | one commit, then reconcile | 1 |
| Act again immediately after a commit | `decision_requires_reconcile` | 1 |
| Act on stale observations after reconciling | `stale_precondition` | 1 |
| Act after fresh re-observation | commits | 2 |
| Handler always returns `{ ok: true }` | premature call still refused pre-dispatch | 0 |
| Handler returns `{ ok: true }` with no record | `malformed_success`, told to reconcile | 0 |
| Handler returns a success missing `effect_id` | `malformed_success` | 0 |
| Handler throws | `execution_failure`, told to reconcile | 0 |
| Reconcile with no `operation_id` | refused | 0 |
| Reconcile an unknown `operation_id` | `authority: "unavailable"`, no invented record | 0 |

The last six rows matter most: they hold even when the domain handler lies,
because the boundary owns the verdict rather than trusting the handler.
