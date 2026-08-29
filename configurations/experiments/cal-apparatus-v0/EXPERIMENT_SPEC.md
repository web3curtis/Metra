# Experiment Spec — cal-apparatus-v0

## Status

**Frozen** 2026-08-29 for Stage 1 (Calibration).  
Authority: user directed use of `EXPERIMENT_VARIABLES.md` + TypeScript/Vite stack; manager encoded concrete fixture/ledger values.

## Research contribution

Prove ReliableRail fixture reset, state oracle, recorder, and evaluator scoring are reproducible before any reliability mechanism or agent trial.

## Hypothesis / falsifier

- **Hypothesis (apparatus):** Identical deterministic scripts against a reset fixture yield identical oracle outcomes and metric calculations.
- **Falsifier:** Divergent final state, duplicate orders, non-deterministic reset, or Mode mismatch under repeated apparatus runs.

## Independent variable

None. All reliability mechanism flags **OFF**.

## Controlled variables

Encoded in `configurations/experiments/cal-apparatus-v0/specification.json` and `configurations/fixtures/fixture-v0.json`. Source ledger: `research/governance/EXPERIMENT_VARIABLES.md`.

## Mode

- `runtime.lane`: `native` (fail closed if polyfill appears)
- Mechanisms: all false
- Agent: **none** — deterministic calibration script only
- Adversity: none
- Critiqor adapter: off
- Personal research dashboard: **out of band** (`private/`; not part of public publish set)

## Acceptance gates

1. Fixture reset → `EMPTY`, zero orders, inventory matches `fixture-v0`
2. Deterministic script completes correct purchase path → oracle `PURCHASED`, total 280 AUD, adjacent seats, winning journey IDs
3. Duplicate finalize attempt creates no second committed order (oracle count ≤ 1) even before D1 flags (count-based)
4. Recorder writes ordered events for the apparatus run
5. Evaluator metrics match expected fixture for the scripted path
6. Repeat apparatus run 3× → identical `final-state.json` oracle fields (excluding wall-clock timestamps)
7. Mode fail-closed stub rejects requested-native / actual-polyfill mismatch in unit test

## Stop conditions

Red/validity incident, evidence corruption, inability to reset deterministically, or undeclared variable change.

## Out of scope

Agent LLM trials, A–D2 modules, personal dashboard publish, Critiqor, external ticket sites.
