# Reliability Boundary — plugin API

Package entry for the universal WebMCP reliability skill.

```ts
import {
  PLUGIN_ID,
  PLUGIN_VERSION,
  validateCall,
  rejectStaleConsequential,
  envelopeFromToolError,
  selectDiagnosisAction,
  newOperationId,
  reconcileAmbiguousCommit,
  decideRecovery,
} from "./plugin/api.ts";
```

See `skills/webmcp-reliability/SKILL.md` for agent instructions.

## Import (plugin-shaped)

```ts
import {
  PLUGIN_ID,
  validateCall,
  rejectStaleConsequential,
  envelopeFromToolError,
  selectDiagnosisAction,
  newOperationId,
  reconcileAmbiguousCommit,
  decideRecovery,
} from "../prototypes/reliability-boundary/plugin/api.ts";
```
