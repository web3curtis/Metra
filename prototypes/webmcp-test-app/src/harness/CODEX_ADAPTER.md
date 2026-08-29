# Codex agent adapter (spike)

## Status

Profile frozen: `configurations/agents/agent.codex-planner.v0.json`  
Execution engine stub: `prototypes/webmcp-test-app/src/harness/codexAgentAdapter.ts`

## Auth

Codex CLI login is **user-assisted**. If `codex` is not authenticated, stop and ask the CEO to log in (do not invent credentials).

Check:

```bash
which codex
codex --version
# or project-specific login command once known
```

## Design

1. Reset fixture + open ReliableRail URL (or in-process tool bridge for first spike).
2. Fresh Codex context each run (`fresh_context_each_run: true`).
3. Tool calls go through `invokeTool` with Mode mechanism flags.
4. Record events via `EventRecorder`; write session artifacts; oracle evaluates.
5. Optional Critiqor sidecar when `runtime.critiqor_adapter` is true.

## First live trial (Yellow until auth proven)

Blocked on CEO Codex login confirmation. Until then, unit tests cover policy/adapter mapping only; reference-planner remains the deterministic control profile.
