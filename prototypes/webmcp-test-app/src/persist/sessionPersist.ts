/**
 * Authoritative session persistence for D2 real-reload survival.
 * Simulated ledger only — no real payments.
 */

import type { ExperimentControls } from "../ui/experimentControls.ts";
import type { OrderSnapshot } from "../domain/types.ts";

const LEDGER_KEY = "reliablerail.authoritative_ledger.v1";
const CONTROLS_KEY = "reliablerail.experiment_controls.v1";
const EFFECTS_KEY = "reliablerail.effect_registry.v1";

export type PersistedLedger = {
  order: OrderSnapshot;
  updated_at: string;
};

export function saveLedger(order: OrderSnapshot): void {
  if (typeof localStorage === "undefined") return;
  const payload: PersistedLedger = {
    order,
    updated_at: new Date().toISOString(),
  };
  localStorage.setItem(LEDGER_KEY, JSON.stringify(payload));
}

export function loadLedger(): PersistedLedger | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(LEDGER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PersistedLedger;
  } catch {
    return null;
  }
}

export function clearLedger(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(LEDGER_KEY);
}

export function saveControls(controls: ExperimentControls): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(CONTROLS_KEY, JSON.stringify(controls));
}

export function loadControls(): ExperimentControls | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(CONTROLS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ExperimentControls;
  } catch {
    return null;
  }
}

export function clearControls(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(CONTROLS_KEY);
}

export function saveEffectRegistry(entries: [string, unknown][]): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(EFFECTS_KEY, JSON.stringify(entries));
}

export function loadEffectRegistry(): [string, unknown][] {
  if (typeof localStorage === "undefined") return [];
  const raw = localStorage.getItem(EFFECTS_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as [string, unknown][];
  } catch {
    return [];
  }
}

export function clearEffectRegistry(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(EFFECTS_KEY);
}

export function clearAllSessionPersist(): void {
  clearLedger();
  clearControls();
  clearEffectRegistry();
}
