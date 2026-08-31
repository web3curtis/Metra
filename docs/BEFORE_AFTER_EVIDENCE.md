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

## Correction — the "after" column at `b46227e` was incomplete

An adversarial review of published `main` (`b46227e`) falsified the claim above
for one call shape that the original evidence did not cover: **reusing a
committed `operation_id` from a different application**.

`BoundarySession.committed` was keyed on `operation_id` alone even though a
single session backs every registered tool. Once any application committed under
`operation_id` X, `phaseOf(X)` returned `"committed"` for every other
application, which set `alreadyCommitted` and disabled the missing/stale evidence
gate. `conflictOnReuse` was computed and logged as
`intent_changed_under_same_operation_id`, but nothing branched on it.

Observed at `b46227e`, driving only registered tools:

| Sequence | Result at `b46227e` | Effects |
| --- | --- | --- |
| commerce observe ×2 → `commerce.create_order` (op X) → `commerce.get_order` (op X) → `support.create_support_ticket` (op X) | mechanism B skipped, **domain handler invoked** with zero support observations; surfaced as `malformed_success` only because the domain runtime also refused | 1 |
| same prefix → `travel.reserve_trip` (op X) | **`ok: true`**, and the envelope carried commerce's order record (`record_type: "order"`, `product_id: "keychron-v6-max"`) under `duplicate_prevented: true` | 1 |

The second row is the worse of the two. The agent is told its trip reservation
succeeded and handed another application's record. That is a false success, not
just a missed gate.

`SuiteToolRuntime` had the same defect independently: its effect ledger was also
keyed on `operation_id` alone, so a cross-application reuse resolved to the wrong
committed record.

### The fix

- `BoundarySession.committed` and `SuiteToolRuntime`'s effect ledger are keyed by
  `(use_case_id, operation_id)`. A commit in one application can no longer answer
  another application's duplicate question.
- An `operation_id` is now owned by the first consequential tool that binds it. A
  consequential call reusing an `operation_id` owned by a different tool fails
  closed with `operation_id_scope_conflict` at D1 — before mechanism B, and
  before dispatch.
- Same-application idempotent replay and reconciliation are unchanged, because
  the owner is the same tool.

`tests/crossUseCaseOperationId.test.ts` pins this: X1 is the exact reported
sequence, X2 sweeps all 30 ordered application pairs, X3 asserts that legitimate
same-application idempotent replay still commits exactly once. X1 and X2 fail
against `b46227e` source and pass after the fix.

### Two further defects found while re-assessing the fix

A second review of the fixed branch reported the invariant as stated does not hold,
and named a same-application idempotent replay: after a commit moves the revision
from 1 to 2, the act's own observations are from revision 1, yet replaying the same
`operation_id` through the same tool still dispatches and returns `ok: true` with
`duplicate_prevented`.

That is intended, and the invariant statement was the thing at fault. The replay
returns the **existing** effect; the effect count does not move. Blocking it on
freshness would push an agent toward minting a new `operation_id`, which is the
duplicate commit the design exists to prevent. Stated correctly: *no act tool may
produce a new effect, and no act tool may report success for an effect the boundary
has not recorded, unless its own required observations are present and current.*
Duplicate suppression of an already-recorded effect is the one exception.

The same review found two defects that are real, and both are fixed here:

1. **The boundary trusted a handler-supplied `duplicate_prevented`.** A replacement
   handler could return `{ ok: true, data: { duplicate_prevented: true } }` for an
   `operation_id` that had never committed. The boundary skipped `recordCommit`,
   wrote a `postconditions_met: true` checkpoint, and returned `ok: true` with
   `effect_count: 0` — a success for an effect that did not exist. This is the same
   class as the bug above: the boundary accepting the handler's account of state it
   should own. The flag is now honoured only when the boundary's own scoped ledger
   already records that commit; otherwise the call fails with
   `unverified_duplicate_claim` and the agent is sent to reconcile.
2. **`minLength` was declared but never enforced.** `operationSchema` and
   `reconcileSchema` declare `minLength: 6` on `operation_id`, and `ArgSpec` already
   carried a `minLength` field, but `validateShape` only rejected empty strings. A
   one-character `operation_id` committed successfully. String length is now checked
   the same way integer `minimum` already was.

`tests/handlerTrustBoundary.test.ts` covers both, plus the case that the fix must
not break: a duplicate the boundary itself recorded is still honoured.

## Reproduce the "after" column

```bash
git clone https://github.com/web3curtis/Metra.git
cd Metra/prototypes/webmcp-test-app
npm ci
npx vitest run tests/liveBoundary.test.ts      # F0-F7, the falsifier
npx vitest run tests/adversarialBoundary.test.ts   # 17 attack attempts
npx vitest run tests/crossUseCaseOperationId.test.ts  # cross-application op reuse
npx vitest run tests/handlerTrustBoundary.test.ts     # handler claims and schema limits
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
| Act reusing another application's committed `operation_id` | `operation_id_scope_conflict`, no dispatch | unchanged |
| Act with a one-character `operation_id` | `contract_violation` | 0 |
| Handler claims `duplicate_prevented` with nothing committed | `unverified_duplicate_claim`, told to reconcile | 0 |
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
