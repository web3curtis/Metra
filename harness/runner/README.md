# Experiment runner

Ownership: Prototype Manager / apparatus-builder.

Implementation lives in:

`prototypes/webmcp-test-app/src/harness/sessionRunner.ts`

Run:

```bash
cd prototypes/webmcp-test-app
npm test -- tests/sessionRunner.test.ts
```

Session layout:

```text
artifacts/experiments/<experiment_id>/<condition>/<run_id>/
  specification.json
  events.jsonl
  final-state.json
  metrics.json
  result.md
```

`artifacts/dashboard-index.json` is rebuildable for the **private** research dashboard only.
