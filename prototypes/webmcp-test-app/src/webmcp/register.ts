import type { ToolResult } from "../domain/types.ts";
import { TOOL_INPUT_SCHEMAS } from "./toolSchemas.ts";

type ToolHandler = (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>;

export type WebMcpLane = "native" | "polyfill" | "unavailable";

export function detectWebMcpLane(
  doc: Document = document,
  requested: "native" | "polyfill" = "native",
): { lane: WebMcpLane; failClosed: boolean; reason?: string } {
  const modelContext = (doc as Document & { modelContext?: unknown }).modelContext;
  const hasNative = typeof modelContext === "object" && modelContext !== null;

  if (requested === "native" && !hasNative) {
    return {
      lane: "unavailable",
      failClosed: true,
      reason: "requested_native_but_document_modelContext_missing",
    };
  }
  if (requested === "native" && hasNative) {
    return { lane: "native", failClosed: false };
  }
  return { lane: hasNative ? "native" : "polyfill", failClosed: false };
}

/**
 * Normalize sync throws and rejected promises for registered handlers.
 */
export async function normalizeHandlerResult(
  run: () => ToolResult | Promise<ToolResult>,
): Promise<ToolResult> {
  try {
    return await Promise.resolve(run());
  } catch (err) {
    const message =
      err instanceof Error ? err.message : typeof err === "string" ? err : "handler_threw";
    return { ok: false, error: message };
  }
}

/** Register tools when document.modelContext is present; forwards all args. */
export function registerReliableRailTools(
  invoke: (name: string, args: Record<string, unknown>) => ToolResult | Promise<ToolResult>,
): { registered: string[]; lane: WebMcpLane; detail: string } {
  const tools: Record<string, ToolHandler> = {
    search_journeys: (args) => invoke("search_journeys", args ?? {}),
    select_journey: (args) => invoke("select_journey", args ?? {}),
    list_available_seats: (args) => invoke("list_available_seats", args ?? {}),
    reserve_seats: (args) => invoke("reserve_seats", args ?? {}),
    review_order: (args) => invoke("review_order", args ?? {}),
    purchase_tickets: (args) => invoke("purchase_tickets", args ?? {}),
    get_order: (args) => invoke("get_order", args ?? {}),
    cancel_draft: (args) => invoke("cancel_draft", args ?? {}),
  };

  const names = Object.keys(tools);
  const doc = document as Document & {
    modelContext?: {
      registerTool?: (def: {
        name: string;
        description: string;
        inputSchema?: object;
        execute: (args: Record<string, unknown>) => unknown;
      }) => void;
    };
  };

  if (!doc.modelContext?.registerTool) {
    return {
      registered: [],
      lane: "unavailable",
      detail: "document.modelContext.registerTool unavailable — UI-only until WebMCP-enabled Chrome",
    };
  }

  const descriptions: Record<string, string> = {
    search_journeys: "Search deterministic ReliableRail journey inventory.",
    select_journey: "Select outbound and return journey IDs.",
    list_available_seats: "List available seats and adjacent pairs for the current draft.",
    reserve_seats: "Reserve adjacent seats for two passengers.",
    review_order: "Review draft order and budget.",
    purchase_tickets:
      "Finalize simulated order exactly once. No payment details. Local state only.",
    get_order: "Get current order snapshot; pass operation_id to reconcile ambiguous commits.",
    cancel_draft: "Cancel draft order before purchase.",
  };

  for (const name of names) {
    doc.modelContext.registerTool({
      name,
      description: descriptions[name] ?? name,
      inputSchema: TOOL_INPUT_SCHEMAS[name] ?? { type: "object" },
      execute: async (args) =>
        normalizeHandlerResult(() => tools[name]?.(args ?? {}) ?? { ok: false, error: "missing_handler" }),
    });
  }

  return {
    registered: names,
    lane: "native",
    detail: `Registered ${names.length} tools on document.modelContext (concrete schemas; args forwarded)`,
  };
}
