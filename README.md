# Metra / ReliableRail WebMCP Sandbox

Implementation-only repository for the ReliableRail WebMCP reliability prototype.

## What this is

A **Vite + TypeScript** web app that exposes simulated rail-booking **WebMCP tools**, plus a switchable **reliability boundary** (contract, freshness, structured failures, diagnosis, effect safety, state recovery).

Purchase is **simulated only** — no payments, no real tickets.

## Quick start

```bash
cd prototypes/webmcp-test-app
npm install
npm run dev
```

Open the printed local URL. Use experiment controls to toggle mechanisms A–D2.

```bash
npm test    # unit + integration + playbook regression
npm run build
```

## Layout

| Path | Role |
|---|---|
| `prototypes/webmcp-test-app/` | Public WebMCP sandbox app + harness |
| `prototypes/reliability-boundary/` | A–D2 mechanism modules |
| `adapters/critiqor/` | Optional one-way Critiqor event export |
| `configurations/` | Fixtures, agent profiles, experiment Mode JSON |
| `harness/` | Runner ownership notes |

## License

Apache-2.0 — see `LICENSE`.
