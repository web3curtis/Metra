import type { Fixture } from "../domain/types.ts";
import type { BatteryReport } from "../harness/fullAdversityBattery.ts";
import type { SideBySideResult } from "../harness/sideBySideComparison.ts";
import {
  bookingStepCopy,
  type BookingViewModel,
} from "../booking/bookingMimic.ts";
import type { AdversityId } from "../adversity/adversityEngine.ts";

export function renderViewTabs(viewMode: "lab" | "booking"): string {
  return `
    <nav class="view-tabs" aria-label="ReliableRail surfaces">
      <button type="button" id="tab-booking" class="${viewMode === "booking" ? "active" : "secondary"}">Booking platform</button>
      <button type="button" id="tab-lab" class="${viewMode === "lab" ? "active" : "secondary"}">Lab / experiment controls</button>
    </nav>
    <p class="meta">Same Syd–CBR simulated track. <strong>Booking</strong> mimics a real ticket site with stresses along the journey. <strong>Lab</strong> exposes flags, tools, and judge harnesses. No real payments.</p>
  `;
}

export function renderBookingSurface(input: {
  fixture: Fixture;
  booking: BookingViewModel;
  battery: BatteryReport | null;
  comparison: SideBySideResult | null;
}): string {
  const copy = bookingStepCopy(input.booking.step);
  const steps = ["search", "select", "seats", "review", "confirm", "done"] as const;
  const stepNav = steps
    .map((s) => {
      const on = s === input.booking.step ? "on" : "";
      return `<span class="step-pill ${on}">${s}</span>`;
    })
    .join("");

  const batteryHtml = input.battery
    ? `<div class="battery">
        <p class="status ${input.battery.all_pass ? "ok" : "bad"}">${input.battery.summary}</p>
        <ul>${input.battery.cells
          .map(
            (c) =>
              `<li><strong>${c.impl}</strong> · <code>${c.adversity}</code> · ${c.pass ? "PASS" : "FAIL"} — ${c.reason}</li>`,
          )
          .join("")}</ul>
      </div>`
    : `<p class="meta">Run the full safety battery to stress A–D2 on this track (like testing every car safety feature on the same road).</p>`;

  const cmp = input.comparison
    ? `<div class="compare-grid">
        <div class="arm raw">
          <h3>Without reliability (raw)</h3>
          <p>commits <code>${input.comparison.raw.committed_purchase_count}</code> · state <code>${input.comparison.raw.order_state}</code> · oracle <code>${input.comparison.raw.oracle_ok}</code></p>
          <pre>${JSON.stringify({ error: input.comparison.raw.last_error, trace: input.comparison.raw.trace }, null, 2)}</pre>
        </div>
        <div class="arm proto">
          <h3>With prototype (A–D2)</h3>
          <p>commits <code>${input.comparison.prototype.committed_purchase_count}</code> · state <code>${input.comparison.prototype.order_state}</code> · recovery <code>${input.comparison.prototype.recovery_action ?? "none"}</code></p>
          <pre>${JSON.stringify({ error: input.comparison.prototype.last_error, diagnosis: input.comparison.prototype.diagnosis_action, structured_failure: input.comparison.prototype.structured_failure, trace: input.comparison.prototype.trace }, null, 2)}</pre>
        </div>
      </div>
      <p class="status ${input.comparison.comparison_valid ? "ok" : "bad"}">improvement=<code>${input.comparison.improvement}</code> — ${input.comparison.summary}</p>`
    : "";

  return `
    <section class="panel booking-hero">
      <h2>ReliableRail Booking</h2>
      <p class="meta">Sydney ↔ Canberra return · ${input.booking.passengers} passengers · budget AUD ${input.booking.budget_aud} · simulated only</p>
      <div class="step-row">${stepNav}</div>
      <h3>${copy.title}</h3>
      <p>${copy.body}</p>
      <div class="booking-card">
        <div><strong>Outbound</strong><div>${input.booking.outbound_label}</div></div>
        <div><strong>Return</strong><div>${input.booking.return_label}</div></div>
        <div><strong>Seats</strong><div>${input.booking.seat_label}</div></div>
        <div><strong>Total</strong><div>AUD ${input.booking.total_aud}</div></div>
      </div>
      <label>Stress at confirm (tests one safety feature on this track)
        <select id="ctl-booking-adversity">
          <option value="none">none — clean purchase</option>
          <option value="contract_ambiguity">A · early / invalid confirm</option>
          <option value="capability_change">B · tools changed mid-flow</option>
          <option value="opaque_failure">C1 · opaque provider error</option>
          <option value="client_timeout_after_commit">C2/D1 · timeout after possible commit</option>
          <option value="reload_after_purchase">D2 · reload after purchase</option>
        </select>
      </label>
      <div class="grid two">
        <button id="btn-booking-next" type="button">${input.booking.step === "done" ? "Restart booking" : input.booking.step === "confirm" ? "Confirm purchase (paired raw vs prototype)" : "Continue"}</button>
        <button id="btn-booking-battery" type="button" class="secondary">Run full A–D2 safety battery</button>
      </div>
    </section>
    <section class="panel judge">
      <h2>Track results — raw vs prototype</h2>
      ${cmp || batteryHtml}
      ${input.battery && !input.comparison ? batteryHtml : input.comparison && input.battery ? `<hr/><h3>Full battery</h3>${batteryHtml}` : ""}
    </section>
  `;
}

export function adversityOptionsSelected(id: AdversityId): string {
  return id;
}
