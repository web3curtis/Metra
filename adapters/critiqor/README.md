# Critiqor adapter (optional, non-authoritative)

One-way export from ReliableRail `events.jsonl` → Critiqor-compatible JSONL, plus optional local diagnosis via Critiqor `generate_diagnosis`.

## Rules

- Off by default (`runtime.critiqor_adapter: false`)
- Never changes WebMCP execution, oracle, primary metrics, or inclusion
- Baseline and intervention use the same adapter path when enabled
- Adapter failure must not fail the experiment run

## Files

| File | Role |
|---|---|
| `mapEvents.ts` | Map RR events → Critiqor RuntimeEvent lines |
| `diagnose_local.py` | Call Critiqor local diagnosis on exported JSONL |
| `writeSidecar.ts` | Write `critiqor/events.jsonl` under a run artifact dir |

## CLI

```bash
# After a run has events.jsonl mapped to critiqor/events.jsonl:
python adapters/critiqor/diagnose_local.py \
  --run-id demo \
  --events artifacts/experiments/<id>/<cond>/<run>/critiqor/events.jsonl \
  --session artifacts/experiments/<id>/<cond>/<run>/final-state.json \
  --critiqor-root "$HOME/Code/Critiqor"
```
