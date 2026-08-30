---
name: webmcp-reliability
description: >-
  Apply ReliableRail-style WebMCP reliability controls (contract, freshness,
  structured failures, diagnosis, effect safety, state recovery) when an agent
  uses WebMCP tools. Use whenever browsing or calling document.modelContext /
  WebMCP tools, especially for consequential actions (purchase, submit, delete).
---

# WebMCP Reliability (universal skill)

## Goal

Improve predictability and reliability of WebMCP tool use—the same class of transitions that helped MCP become production-ready, adapted for in-browser tools.

## When to use

- Any site or local app exposing WebMCP tools
- Multi-step workflows with a consequential final action
- After tool-list changes, timeouts, opaque errors, or page reload

## Rules (always)

1. **Contract:** Do not call a tool if preconditions are unmet; treat schema/precondition violations as `invalid_input_or_precondition`, not success.
2. **Freshness:** Before consequential tools, re-check tool availability / epoch; on stale → **reobserve** (rediscover tools), never blind-retry.
3. **Semantics:** Prefer structured failure fields (category, owner, recoverability, evidence) over opaque `Error` strings.
4. **Diagnosis:** Follow `diagnosis_action`: `reobserve` | `reconcile` | `escalate` | `stop`. Never blind-retry consequential calls.
5. **Effect safety:** Use a client `operation_id` for consequential calls; on timeout/unknown → `get_order` / re-read state (**reconcile**) before any retry; at most one commit per operation.
6. **Recovery:** After reload/navigation, re-observe tools + app state + receipts; then resume, restart draft, or stop—never treat URL alone as truth.

## Struggle → response cheat sheet

| Struggle | Response |
|---|---|
| Stale / missing tool after discovery | Reject call → rediscover → continue or stop |
| Opaque failure | Demand structure; stop if unrecoverable |
| Timeout after possible commit | Reconcile state; do not second purchase |
| Reload mid-flow | Recovery decision from observed state |

## Reference implementation

Install for Codex: [`INSTALL.md`](./INSTALL.md) · Manifest: `.codex-plugin/plugin.json`

Plugin API (site-agnostic):

`prototypes/reliability-boundary/plugin/api.ts`

Modules:

- Contract: `prototypes/reliability-boundary/contract/`
- Freshness: `prototypes/reliability-boundary/freshness/`
- Semantics: `prototypes/reliability-boundary/semantics/`
- Diagnosis: `prototypes/reliability-boundary/diagnosis/`
- Effect safety: `prototypes/reliability-boundary/effect/`
- Recovery: `prototypes/reliability-boundary/recovery/`

Demo app: `prototypes/webmcp-test-app/`

## Success bar

Under injected WebMCP struggles, the agent **overcomes or reduces impact** (safe stop or exactly-once success)—not merely completing the happy path.
