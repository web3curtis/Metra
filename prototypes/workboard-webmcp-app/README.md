# WorkBoard WebMCP (portability G1)

Minimal second-domain Vite app: issue tracker with 3 WebMCP tools and reliability-boundary hooks (A–D2).

## Run

```bash
cd prototypes/workboard-webmcp-app
npm install
npm run dev      # http://localhost:5174
npm test         # vitest
npm run build    # dist/ with base ./
```

## Tools

| Tool | Args | Notes |
|---|---|---|
| `list_projects` | — | Returns in-memory projects |
| `create_issue` | `title` (required), `project_id?` | Forwards `title` through registerTool execute |
| `transition_issue` | `issue_id`, `to_state`, `operation_id?` | DONE is consequential (D1/D2 demo) |

Reliability imports from `../reliability-boundary/plugin/api.ts` only — no ReliableRail store.

Issue state persists to `localStorage` (`workboard-v0`) for reload / D2 demos.

## UI

Mechanism toggles reuse ReliableRail flag names (`contract_conformance` … `state_recovery`). Adversity: `none`, `capability_change`, `opaque_failure`, `client_timeout_after_commit`, `reload`.
