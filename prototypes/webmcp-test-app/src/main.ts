import fixtureJson from "./data/fixture-v0.json";
import {
  EventRecorder,
  invokeTool,
  runScriptedHappyPath,
  type ToolName,
} from "./domain/harness.ts";
import { evaluateOrderOracle } from "./domain/oracle.ts";
import { ReliableRailStore } from "./domain/store.ts";
import type { Fixture } from "./domain/types.ts";
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
import "./style.css";

const fixture = fixtureJson as Fixture;
const store = new ReliableRailStore(fixture);
const recorder = new EventRecorder();
let controls: ExperimentControls = structuredClone(DEFAULT_CONTROLS);

function call(name: ToolName, input: Record<string, unknown> = {}) {
  const m = controls.mechanisms;
  return invokeTool(store, recorder, name, input, "ui", {
    contractConformance: m.contract_conformance,
    capabilityFreshness: m.capability_freshness,
    structuredSemantics: m.structured_semantics,
    diagnosisPolicy: m.diagnosis_policy,
    effectSafety: m.effect_safety,
    // state_recovery is policy-only at UI; applied after reload adversity in harness sessions
    expectedCapabilityEpoch: "epoch:ui",
    actualCapabilityEpoch: "epoch:ui",
  });
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
            <option value="reload_after_purchase">reload_after_purchase</option>
            <option value="state_drift">state_drift</option>
          </select>
        </label>
      </div>
      <div class="mech-grid">${mechanismRows(controls.mechanisms)}</div>
      <p class="status ${baselineSafe ? "ok" : "bad"}">${describeControls(controls)}${
        baselineSafe ? "" : " — invalid: baseline/calibration must have mechanisms off"
      }</p>
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
      <div class="grid two">
        <button id="btn-reset" type="button" class="secondary">Reset fixture</button>
        <button id="btn-script" type="button" ${baselineSafe ? "" : "disabled"}>Run scripted happy path</button>
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
    for (const input of document.querySelectorAll<HTMLInputElement>("input[data-mech]")) {
      const key = input.dataset.mech as keyof MechanismFlags;
      mechanisms[key] = input.checked;
    }
    controls = { condition, adversity, mechanisms };
    render();
  });
  document.querySelector("#btn-reset-controls")?.addEventListener("click", () => {
    controls = structuredClone(DEFAULT_CONTROLS);
    render();
  });
  document.querySelector("#btn-reset")?.addEventListener("click", () => {
    call("reset_fixture");
    render();
  });
  document.querySelector("#btn-script")?.addEventListener("click", () => {
    if (!allMechanismsOff(controls.mechanisms) && controls.condition !== "intervention-preview") {
      return;
    }
    runScriptedHappyPath(store, recorder, "ui-script");
    render();
  });
}

render();
