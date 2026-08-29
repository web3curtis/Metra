# Reliability boundary — plugin surface

Site-agnostic exports for A–D2 mechanisms. Import from `plugin/api.ts`.

| Mechanism | Exports |
|---|---|
| A Contract | `validateCall`, `validateOutput` |
| B Freshness | `computeEpoch`, `rejectStaleConsequential` |
| C1 Semantics | `envelopeFromToolError`, `buildStructuredFailure` |
| C2 Diagnosis | `selectDiagnosisAction` |
| D1 Effect | `newOperationId`, `beginEffect`, `reconcileAmbiguousCommit`, … |
| D2 Recovery | `decideRecovery` |

`PLUGIN_INVOKE_ORDER` documents the recommended gate order for hosts/agents.
Agent instructions: `skills/webmcp-reliability/SKILL.md`.
