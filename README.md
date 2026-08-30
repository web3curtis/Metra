# Metra / ReliableRail WebMCP Sandbox

Implementation-only repository for the ReliableRail WebMCP reliability prototype.

## What this is

A **Vite + TypeScript** web app that exposes simulated rail-booking **WebMCP tools**, plus a switchable **reliability boundary** (contract, freshness, structured failures, diagnosis, effect safety, state recovery).

Implementations **A–D2** are intended to meet a five-criterion bar (struggle mapped, mechanism shipped, stress proven, agent-usable, plugin-shaped).

## Surfaces

| Mode | Role |
|---|---|
| **Booking platform** | Syd–CBR ticket mimic + adversities + full A–D2 battery |
| **Lab** | Mechanism flags, tools, per-adversity side-by-side |

Live: https://web3curtis.github.io/Metra/

## Quality

5/5 = multi-adversity battery on ReliableRail (see local `summary/FIVE_FIVE_FOR_CODEX.md` when provided). Plugin: `.codex-plugin/` + `skills/webmcp-reliability/`.


## Quick start

Live judge demo: https://web3curtis.github.io/Metra/

The repository root is also a Codex-compatible plugin. Its manifest is
`.codex-plugin/plugin.json`, and the universal agent instructions are under
`skills/webmcp-reliability/`.

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
| `skills/webmcp-reliability/` | Universal agent skill (instruct agents to follow reliability rules) |

## License

Apache-2.0 — see `LICENSE`.
