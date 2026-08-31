# Metra / ReliableRail WebMCP sandbox

Public WebMCP demo application (TypeScript + Vite). Simulated ticket workflow and lab surfaces only — no payments, no real bookings.

## Surfaces in this package

| Surface | Role |
|---|---|
| **Booking platform** | Syd–CBR ticket mimic, adversities, full A–D2 battery (`src/booking/`, `src/adversity/`, `src/main.ts`) |
| **Lab modules** | Use-case catalog, paired raw vs prototype runtime, audit contracts (`src/lab/`) |
| **Mechanism harness** | Playbooks, integrated session, stage baselines (`src/harness/`) |

Cross-domain WorkBoard demo lives in `../workboard-webmcp-app/`.

## Local use

```bash
cd prototypes/webmcp-test-app
npm install
npm run dev      # local Vite URL
npm test
npm run build
```

`vercel.json` configures the Vite production build for Vercel deployment.

Fixture source of truth: `configurations/fixtures/fixture-v0.json` (copied into `src/data/` for the app).

Mechanism modules (contract, freshness, structured failure, diagnosis, effect safety, checkpoint recovery, protocol spine) live in `../reliability-boundary/`.

## Direction standard (lab / guided tasks)

1. Observe current tools and authoritative state.
2. Validate contract, constraints, freshness, and effect risk.
3. Act once with a stable operation ID.
4. Verify authoritative state and reconcile ambiguity.
5. Stop, block, or escalate with evidence.

All effects are local simulations.
