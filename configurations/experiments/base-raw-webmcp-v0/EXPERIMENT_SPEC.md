# Experiment Spec — base-raw-webmcp-v0

## Status

**Frozen** 2026-08-29 by Prototype Manager (Green encoding of EXPERIMENT_VARIABLES). Agent trials start after live WebMCP smoke.

## Question

What failures and inefficiencies occur on the fixed ReliableRail task with **all reliability mechanisms off**?

## Independent variable

None.

## Controlled

fixture-v0, task-v0, agent.reference-planner.v0, native lane fail-closed, adversity none, ui_fallback false, budgets max_tool_calls=40 / 600000ms, metrics per EXPERIMENT_VARIABLES common outcomes.

## Repetition

min 5 sessions; batches of 5 to max 20; stability_tolerance_pp=10; material_effect_threshold_pp=10.

## Acceptance to start trials

1. Live WebMCP smoke note recorded  
2. Harness can record a session folder per run  
3. Oracle evaluates final state without agent self-report  

## Falsifier for “apparatus ready”

Cannot open app or Mode mismatch.
