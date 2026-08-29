# Experiment — exp-c2-diagnosis-v0

**Frozen:** 2026-08-29  
**IV:** `diagnosis_policy` (A+B+C1 carried)  
**Substrate:** Critiqor local diagnosis optional via `adapters/critiqor/`; WebMCP evaluator authoritative.

## Hypothesis (under test)

Given fixed C1 envelopes, an evidence-backed response-selection policy improves appropriate-response rate (retry / reobserve / reconcile / escalate / stop) versus envelope-only without policy.

## Controls

- Same fixture, task, budgets
- D1/D2 off
- Critiqor failure must not change oracle metrics
