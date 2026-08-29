import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  exportEventsToCritiqorJsonl,
  type ReliableRailEvent,
} from "./mapEvents.ts";

/**
 * Write Critiqor sidecar under <artifactDir>/critiqor/events.jsonl.
 * Swallows nothing here — callers should catch if adapter must be non-blocking.
 */
export function writeCritiqorSidecar(
  artifactDir: string,
  events: ReliableRailEvent[],
): string {
  const dir = join(artifactDir, "critiqor");
  mkdirSync(dir, { recursive: true });
  const outPath = join(dir, "events.jsonl");
  writeFileSync(outPath, exportEventsToCritiqorJsonl(events), "utf8");
  return outPath;
}
