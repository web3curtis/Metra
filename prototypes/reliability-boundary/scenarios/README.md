# Portable scenario kit (P0 substrate)

Domain-agnostic scenario contracts and a pure-function runner that exercise the **public plugin API** only (`../plugin/api.ts`). No ReliableRail store, no DOM, no `webmcp-test-app` imports in this folder.

## Layout

| File | Purpose |
|---|---|
| `scenarioContract.ts` | `ScenarioContract` type — consequential tool, states, oracle hooks |
| `fixtures/reliablerail.fixture.ts` | Reference descriptor + external fixture path (adapter outside core) |
| `fixtures/workboard.fixture.ts` | WorkBoard: create / transition issue |
| `fixtures/docuflow.fixture.ts` | DocuFlow: publish reviewed document |
| `scenarioRunner.ts` | Runs plugin gates under **off**, **exact-stage**, **full-stack** |

## Runner modes

- **`off`** — mechanisms skipped (control / baseline path).
- **`exact-stage`** — one mechanism from `PLUGIN_INVOKE_ORDER` (e.g. only `capability_freshness`).
- **`full-stack`** — full A→D2 invoke order; early exit on contract/freshness block.

Synthetic adversity keys: `wrong_precondition_state`, `stale_capability_epoch`, `ambiguous_commit_after_timeout`, etc.

## Example

```ts
import { runScenario } from "./scenarioRunner.ts";
import { WORKBOARD_FIXTURE } from "./fixtures/workboard.fixture.ts";

const result = runScenario({
  contract: WORKBOARD_FIXTURE,
  adversityKey: "stale_capability_epoch",
  mode: "exact-stage",
  exactStage: "capability_freshness",
});
```

## Portability static check

Core + plugin must not import ReliableRail app paths. From the test app:

```bash
cd prototypes/webmcp-test-app
npm test -- tests/portabilityStatic.test.ts
```

## ReliableRail adapter

The ReliableRail fixture descriptor points at `configurations/fixtures/fixture-v0.json` via `externalFixtureRef`. Loading that JSON and wiring `ReliableRailStore` belongs in a **site adapter** (e.g. under `prototypes/webmcp-test-app/`), not in this scenarios core.
