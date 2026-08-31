<p align="center">
  <img src="assets/metra-logo.png" alt="Metra logo" width="120" />
</p>

<h1 align="center">Metra</h1>

<p align="center">
  <strong>Maturing WebMCP</strong>
</p>

<p align="center">
  Benchmark. Evaluate. Evolve.
</p>

<p align="center">
  <img alt="License" src="https://img.shields.io/badge/license-Apache%202.0-green">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.x-3178C6">
  <img alt="Status" src="https://img.shields.io/badge/status-prototype-blue">
  <a href="https://web3curtis.github.io/Metra/"><img alt="Live demo" src="https://img.shields.io/badge/demo-GitHub%20Pages-0ea5e9"></a>
</p>

<p align="center">
  <code>cd prototypes/webmcp-test-app && npm install && npm run dev</code>
</p>

Implementation-only repository for the ReliableRail WebMCP reliability prototype: simulated rail-booking **WebMCP tools** plus a switchable **reliability boundary** (contract, freshness, structured failures, diagnosis, effect safety, state recovery).

Purchase is **simulated only** — no payments, no real tickets.

Live judge demo: https://web3curtis.github.io/Metra/

---

## Surfaces

| Mode | Role |
|---|---|
| **Booking platform** | Syd–CBR ticket mimic + adversities + full A–D2 battery |
| **Lab** | Mechanism flags, tools, per-adversity side-by-side |
| **WorkBoard** | Cross-domain portability demo (`prototypes/workboard-webmcp-app/`) |

## What ships

Implementations **A–D2** target a five-criterion bar (struggle mapped, mechanism shipped, stress proven, agent-usable, plugin-shaped), with a shared protocol spine and proof suites under `prototypes/webmcp-test-app/tests/`.

A premature consequential call cannot commit an effect on the registered WebMCP path. The before/after evidence, and the 17 attempts made to defeat it, are in [`docs/BEFORE_AFTER_EVIDENCE.md`](docs/BEFORE_AFTER_EVIDENCE.md). Install and the universal agent prompt are in [`skills/webmcp-reliability/INSTALL.md`](skills/webmcp-reliability/INSTALL.md).

The repository root is a Codex-compatible plugin (`.codex-plugin/plugin.json`) with universal agent instructions in `skills/webmcp-reliability/`.

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
| `prototypes/reliability-boundary/` | A–D2 mechanism modules + protocol spine |
| `prototypes/workboard-webmcp-app/` | Cross-domain WorkBoard WebMCP demo |
| `adapters/critiqor/` | Optional one-way Critiqor event export |
| `configurations/` | Fixtures, agent profiles, experiment Mode JSON |
| `harness/` | Runner ownership notes |
| `skills/webmcp-reliability/` | Universal agent skill |
| `assets/` | Brand logo and banner |

## License

Apache-2.0 — see `LICENSE`.
