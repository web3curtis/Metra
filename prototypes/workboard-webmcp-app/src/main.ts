import { TOOL_INPUT_SCHEMAS, DEFAULT_FLAGS, type MechanismFlags, type AdversityId } from "./schemas.ts";
import { bumpCapabilityEpoch, invokeTool, loadBoard } from "./store.ts";
import { recoveryAfterReload } from "./reliability.ts";
import type { EffectRecord } from "../../reliability-boundary/plugin/api.ts";

type R = { ok: boolean; data?: unknown; error?: string };
const board = loadBoard();
const effects = new Map<string, EffectRecord>();
let flags: MechanismFlags = { ...DEFAULT_FLAGS };
let adversity: AdversityId = "none";
let expectedEpoch = board.capability_epoch;
let last: R | null = null;
let reg = "";

const invoke = (n: string, a: Record<string, unknown>): R => {
  last = invokeTool(board, n as "list_projects" | "create_issue" | "transition_issue", a,
    { flags, adversity, expectedEpoch, effects });
  paint(); return last;
};

const norm = async (run: () => R) => { try { return await Promise.resolve(run()); } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "throw" }; } };

function bootRegister() {
  const mc = (document as Document & { modelContext?: { registerTool?: (d: { name: string; description: string; inputSchema?: object; execute: (a: Record<string, unknown>) => unknown }) => void } }).modelContext;
  if (!mc?.registerTool) { reg = "WebMCP unavailable — UI-only"; return; }
  for (const n of ["list_projects", "create_issue", "transition_issue"]) {
    mc.registerTool({ name: n, description: n, inputSchema: TOOL_INPUT_SCHEMAS[n],
      execute: (a) => norm(() => invoke(n, a ?? {})) });
  }
  reg = "Registered 3 tools (schemas + arg forward)";
}

function paint() {
  const el = document.getElementById("app")!;
  const mech = (Object.keys(flags) as (keyof MechanismFlags)[]).map((k) =>
    `<label><input type="checkbox" data-m="${k}" ${flags[k] ? "checked" : ""}/> ${k}</label>`).join(" ");
  const iss = board.issues.map((i) => `<li>${i.id}: ${i.title} [${i.state}]</li>`).join("") || "<li>(none)</li>";
  el.innerHTML = `<h1>WorkBoard WebMCP</h1><p>${reg}</p><section><h2>Mechanisms A–D2</h2>${mech}</section>
    <section><h2>Adversity</h2><select id="adv">${["none","capability_change","opaque_failure","client_timeout_after_commit","reload"]
      .map((a) => `<option ${adversity === a ? "selected" : ""}>${a}</option>`).join("")}</select></section>
    <section><h2>Create</h2><input id="title" placeholder="title"/><button id="create">create_issue</button></section>
    <section><h2>Transition</h2><input id="iid" placeholder="issue_id"/><select id="to"><option>IN_PROGRESS</option><option>IN_REVIEW</option><option>DONE</option></select><button id="trans">go</button></section>
    <section><h2>Board</h2><ul>${iss}</ul><p>rev=${board.state_revision} epoch=${board.capability_epoch}</p></section>
    <pre>${JSON.stringify(last, null, 2) ?? "—"}</pre><button id="reload">Reload (D2)</button>`;
  el.querySelectorAll("[data-m]").forEach((n) => n.addEventListener("change", (e) => {
    const k = (e.target as HTMLInputElement).dataset.m as keyof MechanismFlags;
    flags[k] = (e.target as HTMLInputElement).checked;
    if (k === "state_recovery" && flags.state_recovery) {
      const d = board.issues.find((i) => i.state === "DONE");
      last = { ok: true, data: { recovery: recoveryAfterReload(d?.state ?? "BACKLOG", d?.id ?? null) } };
    }
  }));
  el.querySelector("#adv")!.addEventListener("change", (e) => {
    adversity = (e.target as HTMLSelectElement).value as AdversityId;
    if (adversity === "capability_change") { bumpCapabilityEpoch(board); paint(); }
    if (adversity === "reload") location.reload();
  });
  el.querySelector("#create")!.addEventListener("click", () => invoke("create_issue", { title: (el.querySelector("#title") as HTMLInputElement).value }));
  el.querySelector("#trans")!.addEventListener("click", () => invoke("transition_issue", {
    issue_id: (el.querySelector("#iid") as HTMLInputElement).value, to_state: (el.querySelector("#to") as HTMLSelectElement).value }));
  el.querySelector("#reload")!.addEventListener("click", () => location.reload());
}

bootRegister(); paint();
