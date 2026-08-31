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

---

WebMCP lets a website hand an agent real tools. The tools work. What is missing is
everything that decides **whether the agent should have called one yet** — and what
it should do when the answer comes back unclear.

Metra is that missing layer, plus the harness that proves it does something.

## The problem, in one run

The same agent behaviour, against the same 24 registered WebMCP tools. The only
difference is whether Metra's boundary sits in front of the handlers.

| The agent… | Correct effects | Raw WebMCP | Metra |
|---|---:|---:|---:|
| acts before gathering required evidence | 0 | **1 committed** | 0, blocked |
| retries after an unclear response | 1 | **2 committed** | 1 |
| acts again on evidence that has gone stale | 1 | **2 committed** | 1 |

Raw WebMCP is not broken here. It is doing exactly what it was asked to do — which
is the point. A `create_support_ticket` tool has nowhere to record that help must
be searched first, so it commits.

Full transcripts: [`docs/comparisons/raw-vs-prototype.md`](docs/comparisons/raw-vs-prototype.md),
regenerated on every test run by `tests/rawVsPrototype.test.ts`.

## What a blocked call looks like

A refusal is only useful if the agent can act on it. Metra never returns a bare error:

```json
{
  "ok": false,
  "error": "invalid_precondition",
  "missing_evidence": ["support.verified_help", "support.customer_context"],
  "allowed_next_action": "observe",
  "next_tool": "support.search_help",
  "effect_count": 0,
  "structured_failure": {
    "category": "invalid_input_or_precondition",
    "owner": "reliability_boundary",
    "recoverability": "automatic"
  }
}
```

One legal next action, named. Zero effects. The domain handler was never reached.

## Install

Metra ships as a plugin with a universal agent skill, so any agent framework that
can read a repository can use it. Paste this into your agent:

```text
Install and follow the Metra WebMCP reliability skill.

1. Clone https://github.com/web3curtis/Metra (or add it to your workspace).
2. Read skills/webmcp-reliability/SKILL.md and treat its six rules as binding
   for the rest of this session.
3. Whenever you use a WebMCP tool (document.modelContext), apply them:
   - Contract: never call a tool whose preconditions are unmet.
   - Freshness: re-observe before any consequential call; never act on stale state.
   - Semantics: read the structured failure fields, not the error string.
   - Diagnosis: obey allowed_next_action; never blind-retry a consequential call.
   - Effect safety: send a stable operation_id; on timeout, reconcile before retry.
   - Recovery: after a reload, re-observe and resume only from verified state.
4. Before any consequential call, state which observations satisfy its
   preconditions. If you cannot, call the observation tool named in next_tool.
```

For Codex-compatible runtimes the repository root is already an installable
plugin — `.codex-plugin/plugin.json` points at `skills/`, so pointing the runtime
at the repo is enough.

To put the boundary in front of your own tools, register them through it instead
of registering them directly:

```ts
import { registerUseCaseSuite } from "./src/webmcp/registerSuite.ts";

const { protocol, session } = registerUseCaseSuite(runtime, document);
```

## Run it

```bash
git clone https://github.com/web3curtis/Metra
cd Metra/prototypes/webmcp-test-app
npm install
npm run dev     # open the printed URL; toggle mechanisms A–D2 live
```

```bash
npm test        # 131 tests, including the live registered-path falsifiers
npm run build
```

Live demo: https://web3curtis.github.io/Metra/ — purchase and ticketing are
**simulated only**. No payments, no real tickets.

## What ships

Six mechanisms, enforced at the registration boundary rather than suggested in a
prompt, so they hold whoever wrote the handler:

| | Mechanism | What it does |
|---|---|---|
| **A** | Contract | Machine-checked args, effect class, and preconditions per tool |
| **B** | Freshness | Tracks which observations are current; blocks stale consequential calls |
| **C1** | Failure semantics | Normalizes every outcome — including malformed success |
| **C2** | Diagnosis | Binds exactly one legal next action and enforces it on the next call |
| **D1** | Effect safety | Operation identity, duplicate suppression, reconcile-before-retry |
| **D2** | Recovery | Verified, resumable checkpoints bound to the live run |

All six appear in a single live trace from the registered path
(`tests/liveBoundary.test.ts`), not in six separate unit tests.

## Layout

| Path | Role |
|---|---|
| `prototypes/webmcp-test-app/` | WebMCP sandbox app, boundary, and harness |
| `prototypes/webmcp-test-app/src/webmcp/enforcedBoundary.ts` | The A–D2 enforcement layer |
| `prototypes/reliability-boundary/` | Mechanism modules + protocol spine |
| `prototypes/workboard-webmcp-app/` | Cross-domain portability demo |
| `skills/webmcp-reliability/` | Universal agent skill |
| `docs/comparisons/` | Generated raw vs prototype evidence |
| `tools/freeze-candidate.sh` | Reproducible content digest for a candidate |

## Status

Prototype. The simulated applications are fixtures, not production integrations,
and the comparison above measures behaviour against those fixtures rather than
against live websites. Independent runtime evaluation is ongoing.

## License

Apache-2.0 — see `LICENSE`.
