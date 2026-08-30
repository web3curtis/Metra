import fixtureJson from "./data/fixture-v0.json";
import {
  EventRecorder,
  invokeTool,
  runScriptedHappyPath,
  type ToolName,
} from "./domain/harness.ts";
import { evaluateOrderOracle } from "./domain/oracle.ts";
import { ReliableRailStore } from "./domain/store.ts";
import type { Fixture, ToolResult } from "./domain/types.ts";
import {
  DEFAULT_CONTROLS,
  allMechanismsOff,
  describeControls,
  type AdversityId,
  type DemoCondition,
  type ExperimentControls,
  type MechanismFlags,
} from "./ui/experimentControls.ts";
import { detectWebMcpLane, registerReliableRailTools } from "./webmcp/register.ts";
import { decideRecovery } from "../../reliability-boundary/recovery/stateRecovery.ts";
import type { EffectRecord } from "../../reliability-boundary/effect/effectSafety.ts";
import {
  allowConsequentialCall,
  applyDiagnosisDecision,
  createDiagnosisGate,
  type DiagnosisGateState,
} from "../../reliability-boundary/diagnosis/diagnosisExecutor.ts";
import type { DiagnosisDecision } from "../../reliability-boundary/diagnosis/diagnosisPolicy.ts";
import {
  createAdversityReceipt,
  type AdversityReceipt,
} from "./adversity/adversityEngine.ts";
import {
  clearAllSessionPersist,
  loadControls,
  loadEffectRegistry,
  loadLedger,
  saveControls,
  saveEffectRegistry,
  saveLedger,
} from "./persist/sessionPersist.ts";
import "./style.css";

const fixture = fixtureJson as Fixture;
const store = new ReliableRailStore(fixture);
const recorder = new EventRecorder();
const effectRegistry = new Map<string, EffectRecord>();

let controls: ExperimentControls = structuredClone(DEFAULT_CONTROLS);
let lastRecovery: ReturnType<typeof decideRecovery> | null = null;
let lastToolResult: ToolResult | null = null;
let lastAdversityReceipt: AdversityReceipt | null = null;
let capabilityEpoch = "epoch:ui";
let purchaseBlockedByRecovery = false;
let diagnosisGate: DiagnosisGateState = createDiagnosisGate();
let diagnosisReconciled = false;
let diagnosisReobserved = false;

const persistedControls = loadControls();
if (persistedControls) controls = persistedControls;
const persistedLedger = loadLedger();
if (persistedLedger?.order) {
  store.hydrateOrder(persistedLedger.order);
}
for (const [id, rec] of loadEffectRegistry()) {
  effectRegistry.set(id, rec as EffectRecord);
}

function persistSession(): void {
  saveLedger(store.getOrder());
  saveControls(controls);
  saveEffectRegistry([...effectRegistry.entries()]);
}

function refreshAdversityReceipt(): AdversityReceipt {
  lastAdversityReceipt = createAdversityReceipt({
    adversity_id: controls.adversity,
    arm: allMechanismsOff(controls.mechanisms) ? "control" : "treatment",
  });
  if (controls.adversity === "capability_change") {
    capabilityEpoch = lastAdversityReceipt.payload.new_epoch ?? "epoch:changed";
  } else {
    capabilityEpoch = "epoch:ui";
  }
  return lastAdversityReceipt;
}

function runStateRecoveryIfEnabled(): void {
  purchaseBlockedByRecovery = false;
  if (!controls.mechanisms.state_recovery) {
    lastRecovery = null;
    return;
  }
  const order = store.getOrder();
  lastRecovery = decideRecovery({
    tools_include_purchase: true,
    order_state: order.state,
    order_id: order.order_id,
    receipt_id: order.receipt_id,
    total_aud: order.total_aud,
    budget_aud: fixture.budget_aud,
    seat_ids: order.seat_ids,
    price_drift: controls.adversity === "state_drift",
    seat_drift: controls.adversity === "state_drift",
  });
  if (lastRecovery.action === "stop") {
    purchaseBlockedByRecovery = true;
  }
  recorder.record({
    component: "harness",
    stage: "ui",
    event_type: "recovery_decision",
    payload: { ...lastRecovery, enforced: true },
  });
}

function call(name: ToolName, input: Record<string, unknown> = {}): ToolResult {
  const m = controls.mechanisms;
  const receipt = lastAdversityReceipt ?? refreshAdversityReceipt();

  if (name === "purchase_tickets" && purchaseBlockedByRecovery) {
    const blocked: ToolResult = {
      ok: false,
      error: "recovery_stop_enforced",
      data: { recovery: lastRecovery, adversity_receipt: receipt },
    };
    lastToolResult = blocked;
    recorder.record({
      component: "harness",
      stage: "ui",
      event_type: "recovery_enforced_block",
      payload: { tool: name },
    });
    return blocked;
  }

  if (name === "purchase_tickets" && m.diagnosis_policy) {
    const gateCheck = allowConsequentialCall(diagnosisGate, {
      reconciled: diagnosisReconciled,
      reobserved: diagnosisReobserved,
    });
    if (!gateCheck.ok) {
      const blocked: ToolResult = {
        ok: false,
        error: gateCheck.code,
        data: { diagnosis_gate: diagnosisGate, adversity_receipt: receipt },
      };
      lastToolResult = blocked;
      return blocked;
    }
  }

  if (name === "get_order" && typeof input.operation_id === "string") {
    diagnosisReconciled = true;
  }

  const timeoutAdversity =
    controls.adversity === "client_timeout_after_commit" && name === "purchase_tickets";

  const opaqueAdversity =
    controls.adversity === "opaque_failure" &&
    name === "purchase_tickets" &&
    store.getOrder().state === "ORDER_REVIEWED";

  const result = invokeTool(store, recorder, name, input, "ui", {
    contractConformance: m.contract_conformance,
    capabilityFreshness: m.capability_freshness,
    structuredSemantics: m.structured_semantics,
    diagnosisPolicy: m.diagnosis_policy,
    effectSafety: m.effect_safety,
    effectRegistry,
    simulateClientTimeoutAfterCommit: timeoutAdversity,
    injectOpaqueError: opaqueAdversity
      ? (receipt.payload.opaque_error ?? "opaque_provider_failure")
      : undefined,
    expectedCapabilityEpoch: "epoch:ui",
    actualCapabilityEpoch: capabilityEpoch,
  });

  lastToolResult = {
    ...result,
    data: {
      ...(typeof result.data === "object" && result.data !== null
        ? (result.data as Record<string, unknown>)
        : {}),
      adversity_receipt: receipt,
    },
  };

  if (m.diagnosis_policy && !result.ok && result.data && typeof result.data === "object") {
    const decision = (result.data as { diagnosis_action?: DiagnosisDecision }).diagnosis_action;
    if (decision) {
      diagnosisGate = applyDiagnosisDecision(diagnosisGate, decision);
      if (decision.action === "reobserve") {
        diagnosisReobserved = false;
        capabilityEpoch = "epoch:ui";
      }
      if (decision.action === "reconcile") {
        diagnosisReconciled = false;
      }
    }
  }

  if (controls.adversity === "capability_change" && name !== "purchase_tickets") {
    // After reobserve-style rediscovery, allow refresh
    if (name === "search_journeys" || name === "list_available_seats") {
      diagnosisReobserved = true;
      capabilityEpoch = receipt.payload.new_epoch ?? capabilityEpoch;
    }
  }

  persistSession();
  return lastToolResult;
}

refreshAdversityReceipt();
if (controls.mechanisms.state_recovery && store.getOrder().state === "PURCHASED") {
  runStateRecoveryIfEnabled();
}

const registration = registerReliableRailTools((name, args) =>
  call(name as ToolName, args),
);

function mechanismRows(flags: MechanismFlags): string {
  return (Object.keys(flags) as (keyof MechanismFlags)[])
    .map((key) => {
      const checked = flags[key] ? "checked" : "";
      return `<label class="check"><input type="checkbox" data-mech="${key}" ${checked}/> <code>${key}</code></label>`;
    })
    .join("");
}

function render() {
  const order = store.getOrder();
  const oracle = evaluateOrderOracle(fixture, order);
  const lane = detectWebMcpLane(document, "native");
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) return;

  const baselineSafe =
    controls.condition === "baseline" || controls.condition === "calibration"
      ? allMechanismsOff(controls.mechanisms)
      : true;

  const journeys = fixture.journeys
    .map(
      (j) => `
      <div class="journey">
        <strong>${j.journey_id}</strong>
        <div>${j.origin} → ${j.destination}</div>
        <div>${j.depart_at} · ${j.class} · ${j.price_per_passenger_aud} ${fixture.currency}/pax</div>
      </div>`,
    )
    .join("");

  app.innerHTML = `
    <header class="brand">
      <h1>ReliableRail</h1>
      <p>Simulated Sydney–Canberra sandbox for WebMCP reliability experiments. No real tickets, payments, or credentials.</p>
    </header>

    <section class="panel">
      <h2>Experiment controls</h2>
      <p class="meta">A–D2 mechanisms switchable below. Baseline/calibration require all mechanisms off. Purchase is simulated only.</p>
      <div class="grid two">
        <label>Condition
          <select id="ctl-condition">
            <option value="calibration" ${controls.condition === "calibration" ? "selected" : ""}>calibration</option>
            <option value="baseline" ${controls.condition === "baseline" ? "selected" : ""}>baseline</option>
            <option value="intervention-preview" ${controls.condition === "intervention-preview" ? "selected" : ""}>intervention-preview</option>
          </select>
        </label>
        <label>Adversity
          <select id="ctl-adversity">
            <option value="none">none</option>
            <option value="contract_ambiguity">contract_ambiguity</option>
            <option value="capability_change">capability_change</option>
            <option value="opaque_failure">opaque_failure</option>
            <option value="client_timeout_after_commit">client_timeout_after_commit</option>
            <option value="reload_after_purchase">reload_after_purchase</option>
            <option value="state_drift">state_drift</option>
          </select>
        </label>
      </div>
      <div class="mech-grid">${mechanismRows(controls.mechanisms)}</div>
      <p class="status ${baselineSafe ? "ok" : "bad"}">${describeControls(controls)}${
        baselineSafe ? "" : " — invalid: baseline/calibration must have mechanisms off"
      }</p>
      <p class="meta">Adversity receipt: <code>${lastAdversityReceipt?.adversity_id ?? "none"}</code>
        · epoch <code>${capabilityEpoch}</code>
        · recovery block <code>${purchaseBlockedByRecovery}</code></p>
      <div class="grid two">
        <button id="btn-apply-controls" type="button" class="secondary">Apply control selection</button>
        <button id="btn-reset-controls" type="button" class="secondary">Reset controls to baseline</button>
      </div>
    </section>

    <section class="panel">
      <h2>Mode / runtime</h2>
      <div class="meta">
        Fixture <code>${fixture.fixture_version}</code> ·
        State <code>${order.state}</code> ·
        Revision <code>${order.state_revision}</code> ·
        Committed <code>${order.committed_purchase_count}</code> ·
        WebMCP lane <code>${lane.lane}</code>
        ${lane.failClosed ? ` · <span class="status bad">fail-closed: ${lane.reason}</span>` : ""}
      </div>
      <p>${registration.detail}</p>
      <ul class="tools">
        <li><code>search_journeys</code></li>
        <li><code>select_journey</code></li>
        <li><code>list_available_seats</code></li>
        <li><code>reserve_seats</code></li>
        <li><code>review_order</code></li>
        <li><code>purchase_tickets</code> (simulated finalize)</li>
        <li><code>get_order</code></li>
        <li><code>cancel_draft</code></li>
      </ul>
    </section>

    <section class="panel">
      <h2>Inventory</h2>
      <div class="grid two">${journeys}</div>
    </section>

    <section class="panel">
      <h2>Order state</h2>
      <pre>${JSON.stringify(order, null, 2)}</pre>
      <p class="status ${oracle.ok ? "ok" : "bad"}">
        Oracle: ${oracle.ok ? "correct PURCHASED outcome" : oracle.reasons.join(", ") || "incomplete"}
      </p>
      ${
        lastRecovery
          ? `<p class="meta">D2 recovery: <code>${lastRecovery.action}</code> — ${lastRecovery.rationale} (enforced=${purchaseBlockedByRecovery})</p>`
          : ""
      }
      <h3>Last tool result</h3>
      <pre>${JSON.stringify(lastToolResult, null, 2)}</pre>
      <div class="grid two">
        <button id="btn-reset" type="button" class="secondary">Reset fixture</button>
        <button id="btn-script" type="button" ${baselineSafe ? "" : "disabled"}>Run scripted happy path</button>
      </div>
      <div class="grid two">
        <button id="btn-recovery" type="button" class="secondary">Run D2 re-observe (if enabled)</button>
        <button id="btn-early-purchase" type="button" class="secondary">Stress: early purchase (contract)</button>
      </div>
    </section>
  `;

  const adv = document.querySelector<HTMLSelectElement>("#ctl-adversity");
  if (adv) adv.value = controls.adversity;

  document.querySelector("#btn-apply-controls")?.addEventListener("click", () => {
    const condition = document.querySelector<HTMLSelectElement>("#ctl-condition")
      ?.value as DemoCondition;
    const adversity = document.querySelector<HTMLSelectElement>("#ctl-adversity")
      ?.value as AdversityId;
    const mechanisms = { ...controls.mechanisms };
    for (const inputEl of document.querySelectorAll<HTMLInputElement>("input[data-mech]")) {
      const key = inputEl.dataset.mech as keyof MechanismFlags;
      mechanisms[key] = inputEl.checked;
    }
    controls = { condition, adversity, mechanisms };
    refreshAdversityReceipt();
    runStateRecoveryIfEnabled();
    persistSession();
    render();
  });
  document.querySelector("#btn-reset-controls")?.addEventListener("click", () => {
    controls = structuredClone(DEFAULT_CONTROLS);
    lastRecovery = null;
    purchaseBlockedByRecovery = false;
    refreshAdversityReceipt();
    persistSession();
    render();
  });
  document.querySelector("#btn-reset")?.addEventListener("click", () => {
    call("reset_fixture");
    effectRegistry.clear();
    clearAllSessionPersist();
    lastRecovery = null;
    purchaseBlockedByRecovery = false;
    lastToolResult = null;
    diagnosisGate = createDiagnosisGate();
    diagnosisReconciled = false;
    diagnosisReobserved = false;
    refreshAdversityReceipt();
    render();
  });
  document.querySelector("#btn-script")?.addEventListener("click", () => {
    if (!allMechanismsOff(controls.mechanisms) && controls.condition !== "intervention-preview") {
      return;
    }
    runScriptedHappyPath(store, recorder, "ui-script");
    persistSession();
    runStateRecoveryIfEnabled();
    render();
  });
  document.querySelector("#btn-early-purchase")?.addEventListener("click", () => {
    controls = { ...controls, adversity: "contract_ambiguity" };
    refreshAdversityReceipt();
    call("purchase_tickets", {});
    render();
  });
  document.querySelector("#btn-recovery")?.addEventListener("click", () => {
    if (!controls.mechanisms.state_recovery) return;
    runStateRecoveryIfEnabled();
    persistSession();
    render();
  });
}

render();
