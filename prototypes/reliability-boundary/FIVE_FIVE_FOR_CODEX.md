# FIVE_FIVE — Codex verification brief (binding)

**Audience:** Codex (and any verifier agent).  
**CEO role:** Wait until you report **production-ready** (all A–D2 are 5/5 *and* improvements below are present in this repo); CEO then tests personally.  
**Repo:** https://github.com/web3curtis/Metra  

This is the **single source of truth** for:
1. What a **5/5** looks like (detailed, not score numbers alone).
2. The **score / improvement log** so you can compare **before vs after** and confirm each uplift actually landed in code.

Local research copies under `summary/` (if present in a private workspace) are secondary; **this file in Metra wins**.

---

## How Codex should use this file

1. Read **Shared rubric** and each implementation’s **5/5 portrait**.
2. Read **Improvement log** — for every `from → to`, confirm the listed files/behaviors exist.
3. Run verification (below). If anything in the log is missing or a criterion fails, the implementation is **not** 5/5 yet — report which criterion failed and why.
4. Only say **production-ready for A–D2** when all six implementations pass all five criteria *and* the after-state of the log is observable in tree + tests.
5. Do **not** confuse pillars (live URL deploy) with A–D2 scores. Pillars are end products; CEO owns live URL. Your job here is A–D2 quality + that the logged fixes took effect.

### Quick verification commands

```bash
cd prototypes/webmcp-test-app
npm install
npm test -- --run
# Must include fiveFiveProof, codexPlaybook, integratedSession, effectSafety, stateRecovery, etc.
npm run build
```

Key proof files:

| What | Path |
|---|---|
| Plugin surface (criterion 5) | `prototypes/reliability-boundary/plugin/api.ts` |
| Universal skill | `skills/webmcp-reliability/SKILL.md` |
| Stress + 5/5 proofs | `prototypes/webmcp-test-app/tests/fiveFiveProof.test.ts` |
| Diagnosis follow (C2 agent-usable) | `prototypes/webmcp-test-app/src/harness/integratedSession.ts` |
| Playbook agent (B/C2) | `prototypes/webmcp-test-app/src/harness/codexPlaybookSession.ts` |
| D2 UI recovery | `prototypes/webmcp-test-app/src/main.ts` |
| Mechanism modules | `prototypes/reliability-boundary/{contract,freshness,semantics,diagnosis,effect,recovery}/` |

---

## Shared rubric (each of A, B, C1, C2, D1, D2)

A score of **5/5** means **all five** criteria PASS for that implementation. Partial credit is not 5/5.

| # | Criterion | PASS means (detail) | FAIL looks like |
|---|---|---|---|
| 1 | **Struggle mapped** | Named WebMCP struggle + analogous MCP→production transition + adversity/Mode used in tests | Mechanism exists with no named struggle or no adversity hook |
| 2 | **Mechanism shipped** | Switchable boundary module + experiment flag; can be turned off for control runs | Logic only in prompts, or always-on with no flag |
| 3 | **Stress proven** | Under that struggle, run **overcomes or reduces impact** vs raw/off (safe reject, ≤1 commit, stop, etc.). Evidence: automated test and/or Supported COMPARISON. Happy-path-only is insufficient | Mixed/unsupported under struggle; only demo happy path |
| 4 | **Agent-usable** | When flag is on, the **default runtime/agent path** enables and **follows** the mechanism (cannot casually skip the gate; diagnosis/recovery actually followed) | Module exists but agents blind-retry; op-id optional and unused; recovery only in a dead helper |
| 5 | **Plugin-shaped** | Exported from `plugin/api.ts` + documented in `skills/webmcp-reliability/SKILL.md` with site-agnostic invoke meaning | App-only helper not exported; skill silent on that mechanism |

**Successful prototype mindset:** struggles try to make the run worse; the implementation must overcome or reduce that impact—not merely complete an undisturbed booking.

### Pillars (not A–D2 scores)

| Pillar | Meaning | Codex note |
|---|---|---|
| GitHub | Implementations published on Metra | You are reading this on that pillar |
| Live website | Hosted app judges can open with no install | Separate from 5/5; may still be pending |
| Universal plugin/skill | Agents can install/instruct the layer | Skill + `plugin/api.ts` are the artifacts |

Demo video is separate.

---

## What 5/5 looks like — per implementation

### A — Contract / conformance — 5/5 portrait

**Struggle:** Ambiguous or invalid consequential tool use (e.g. `purchase_tickets` before draft/review preconditions). Analogous to MCP contract/conformance transitions.

**At 5/5 you must observe:**

1. **Struggle mapped** — Invalid/early purchase (or equivalent contract ambiguity) is an explicit stress path.
2. **Mechanism** — `contractV0` (`validateCall` / `validateOutput`) behind flag `contract_conformance`.
3. **Stress** — With gate on: invalid attempts get stable **`contract_violation`** (plus structured failure / diagnosis stop when C1/C2 on); **0 purchases committed**. Raw path may also avoid commit via opaque errors—the *improvement* is stable classification + agent-stoppable semantics, not “sometimes crashes.”
4. **Agent-usable** — `invokeTool` (and any agent session using it) **cannot skip** the contract gate when the flag is on.
5. **Plugin** — `validateCall`, `validateOutput` from `plugin/api.ts`; skill **Contract** rule.

**Prove it:** `fiveFiveProof` “A contract 5/5 stress”; plugin export test.

---

### B — Capability freshness — 5/5 portrait

**Struggle:** Stale tool/capability after discovery (list_changed / epoch asymmetry). Agent acts on an outdated tool view.

**At 5/5 you must observe:**

1. Struggle mapped as stale consequential call (epoch mismatch).
2. Mechanism: epoch + `rejectStaleConsequential` behind `capability_freshness`.
3. Stress: stale purchase **rejected, 0 commits**; after **reobserve** / refreshed epoch, at most **one** successful purchase when playbook follows.
4. Agent-usable: playbook/session on stale → **reobserve** (rediscover / refresh epoch), never blind-retry purchase.
5. Plugin: `computeEpoch`, `rejectStaleConsequential`; skill **Freshness**.

**Prove it:** freshness tests + `codexPlaybook` / `fiveFiveProof` stale paths.

---

### C1 — Structured failure semantics — 5/5 portrait

**Struggle:** Opaque `Error` strings that hide owner, recoverability, and evidence—agents guess.

**At 5/5 you must observe:**

1. Struggle mapped (opaque failure / structured semantics adversity).
2. Mechanism: envelope / `structured_failure` behind `structured_semantics`.
3. Stress: with flag on, failures carry category/owner/recoverability/evidence (or equivalent fields); diagnostic completeness improves vs off.
4. Agent-usable: when flag on, tool failures **always** attach structured envelope on the invoke path agents see.
5. Plugin: `envelopeFromToolError`, `buildStructuredFailure`; skill **Semantics**.

**Prove it:** `structuredFailure` tests + fiveFiveProof / integrated paths with semantics on.

---

### C2 — Runtime diagnosis — 5/5 portrait

**Struggle:** Wrong next action after failure (especially blind-retry of consequential tools).

**At 5/5 you must observe:**

1. Struggle mapped (misdiagnosis / blind retry).
2. Mechanism: `selectDiagnosisAction` (+ optional Critiqor adapter) behind `diagnosis_policy`.
3. Stress: same failure class → appropriate action (`reobserve` | `reconcile` | `escalate` | `stop`); playbook/session that **follows** diagnosis beats blind retry (e.g. stale → reobserve → recover).
4. Agent-usable: runtime emits `diagnosis_action`; **integrated / playbook sessions follow it** (see `playbook_follow` / no blind second purchase except controlled duplicate probes).
5. Plugin: `selectDiagnosisAction`; skill **Diagnosis**.

**Prove it:** `diagnosisPolicy` tests, `codexPlaybook`, integratedSession follow path in `fiveFiveProof` / harness.

---

### D1 — Effect safety — 5/5 portrait

**Struggle:** Client timeout / unmount after a possible commit → ambiguous whether purchase landed → double submit.

**At 5/5 you must observe:**

1. Struggle mapped (`client_timeout_after_commit` or equivalent).
2. Mechanism: operation id, commit/unknown marks, reconcile, duplicate reject behind `effect_safety`.
3. Stress: under timeout-after-commit, **≤1 purchase** committed; reconcile via `get_order` / state before retry.
4. Agent-usable: when flag on, consequential calls **auto-bind `operation_id`** on the session path (agent need not remember to invent one).
5. Plugin: `newOperationId`, `beginEffect`, `reconcileAmbiguousCommit`, `rejectDuplicateOperation`, etc.; skill **Effect safety**.

**Prove it:** `effectSafety` tests + fiveFiveProof D1 + integratedSession auto op-id.

---

### D2 — State-aware recovery — 5/5 portrait

**Struggle:** Reload / navigation / UI–URL drift after review or purchase; treating URL as truth → duplicate purchase.

**At 5/5 you must observe:**

1. Struggle mapped (`reload_after_review` / reload-after-purchase style adversity).
2. Mechanism: `decideRecovery` behind `state_recovery`.
3. Stress: after purchase + reload/reobserve, decision is safe (**stop** / resume / restart draft as appropriate) and **no second commit**.
4. Agent-usable: app UI and/or session path **invokes** recovery when adversity/reload path is active (not a dead export).
5. Plugin: `decideRecovery`; skill **Recovery**.

**Prove it:** `stateRecovery` tests + fiveFiveProof D2 + `main.ts` recovery wiring.

---

## Score & improvement log (before → after)

Use this section to detect whether claimed uplifts **took effect**. If code matches **After** but tests fail, report **not production-ready**. If tests pass but a listed after-behavior is absent, report **log drift**.

### Snapshot — Before (v0 baseline, 2026-08-29)

| Impl | Score | What was wrong (detail) |
|---|---:|---|
| A | **3/5** | Mechanism + struggle existed, but stress story was Mixed / happy-path heavy; not plugin-shaped; diagnosis-stop story incomplete for invalid calls |
| B | **4/5** | Stale reject worked; playbook path largely OK; **missing plugin export + skill as first-class criterion 5** |
| C1 | **3/5** | Envelope module existed; agent-default attachment / completeness under stress weak; not plugin-shaped |
| C2 | **3/5** | Policy existed; Critiqor optional; **following** diagnosis was not the integrated default; not plugin-shaped |
| D1 | **3/5** | Effect safety modules existed; **operation_id easy to omit** on agent path; not plugin-shaped |
| D2 | **2/5** | `decideRecovery` existed as logic but **not wired** into app/session stress; weak proof; not plugin-shaped |

**Mean ~3.2/5. None production-ready.**

---

### v1 — D2 wiring only

| Impl | from → to | Change that must be visible | How to confirm took effect |
|---|---|---|---|
| D2 | 2/5 → **3/5** | Public app exposes recovery decision after observe (button / adversity path calls `decideRecovery`) | `main.ts` imports/calls `decideRecovery`; UI or harness records recovery decision |

Still not 5/5 (stress + plugin incomplete).

---

### v2 — Full 5/5 completion (current After state)

Cross-cutting (all implementations, criterion 5):

| Change | After-state evidence |
|---|---|
| Plugin API | `prototypes/reliability-boundary/plugin/api.ts` exports A–D2 symbols; `PLUGIN_ID`, `PLUGIN_VERSION`, `PLUGIN_INVOKE_ORDER` |
| Plugin docs | `prototypes/reliability-boundary/plugin/README.md` |
| Universal skill | `skills/webmcp-reliability/SKILL.md` lists Contract, Freshness, Semantics, Diagnosis, Effect safety, Recovery |
| Proof suite | `prototypes/webmcp-test-app/tests/fiveFiveProof.test.ts` green |

Per implementation:

| Impl | from → to | What changed (detail) | After-state you must see | Criterion closed |
|---|---|---|---|---|
| **A** | 3/5 → **5/5** | Invalid-call stress loop (×5): gated path returns `contract_violation`, structured failure, diagnosis **stop**, 0 commits; COMPARISON Supported narrative | `fiveFiveProof` A block; contract gate on `invokeTool` | 3,4,5 (1–2 already present) |
| **B** | 4/5 → **5/5** | Confirmed stale reject + playbook reobserve recovery; exported freshness helpers on plugin; skill Freshness | Plugin exports + playbook/freshness tests | 5 (+ confirm 3–4) |
| **C1** | 3/5 → **5/5** | Envelope on failure path with flags; plugin `envelopeFromToolError` | Structured failure present on gated invalid purchase in fiveFiveProof | 3,4,5 |
| **C2** | 3/5 → **5/5** | Integrated session **follows** `diagnosis_action` (`reobserve` refreshes epoch; stop/escalate does not blind-retry); plugin `selectDiagnosisAction` | `integratedSession.ts` `playbook_follow` path; playbook tests | 3,4,5 |
| **D1** | 3/5 → **5/5** | When `effect_safety` on, session **auto-binds** `operation_id`; timeout-after-commit ≤1 purchase; plugin reconcile exports | Auto op-id in `integratedSession`; effectSafety / fiveFiveProof D1 | 3,4,5 |
| **D2** | 3/5 → **5/5** | Full reload-after-purchase / recovery session: **stop**, no duplicate commit; UI + session wiring; plugin export | fiveFiveProof D2; `decideRecovery` in main + harness | 3,4,5 |

### Snapshot — After (Manager claim; Codex must independently verify)

| Impl | Score | One-line after-state |
|---|---:|---|
| A | **5/5** | Invalid purchase gated → `contract_violation` + stop semantics; plugin+skill |
| B | **5/5** | Stale reject; reobserve recovers; plugin+skill |
| C1 | **5/5** | Structured envelopes on failure path; plugin+skill |
| C2 | **5/5** | Diagnosis emitted **and followed**; plugin+skill |
| D1 | **5/5** | Auto op-id + ≤1 under timeout; plugin+skill |
| D2 | **5/5** | Recovery wired; reload stress no dup purchase; plugin+skill |

---

## Production-ready signal (what to tell the CEO)

When verification passes, report in this form:

> **A–D2 production-ready (5/5):** Verified against `prototypes/reliability-boundary/FIVE_FIVE_FOR_CODEX.md`. All six implementations PASS criteria 1–5. Improvement log After-state observed in tree + `npm test`. CEO may begin personal testing.  
> **Pillars:** GitHub=yes; Plugin/skill=yes; Live URL=… (state factually).

If anything fails:

> **Not production-ready.** Failed: \<Impl\> criterion \<#\> — \<observed vs expected\>. Missing from improvement log After-state: \<path or behavior\>.

CEO will only engage for personal testing after your production-ready report.

---

## With / without experiments (for impact measurement)

After quality is verified, impact experiments are separate:

| Arm | Skill/plugin | App mechanism flags |
|---|---|---|
| Control | Do **not** give Codex the skill | Mechanisms **off** |
| Treatment | Give `skills/webmcp-reliability/SKILL.md` | Matching mechanisms **on** |

Same task, same struggles. Compare commits, safe stops, blind retries, oracle. That answers whether implementations change WebMCP performance—not whether they are 5/5 (this file answers 5/5).
