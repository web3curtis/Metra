import type { ToolResult } from "../domain/types.ts";

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

/** Register tools when document.modelContext is present; otherwise expose inventory for UI/debug. */
export function registerReliableRailTools(
  invoke: (name: string, args: Record<string, unknown>) => ToolResult,
): { registered: string[]; lane: WebMcpLane; detail: string } {
  const tools: Record<string, ToolHandler> = {
    search_journeys: (args) => invoke("search_journeys", args),
    select_journey: (args) => invoke("select_journey", args),
    list_available_seats: () => invoke("list_available_seats", {}),
    reserve_seats: (args) => invoke("reserve_seats", args),
    review_order: () => invoke("review_order", {}),
    purchase_tickets: () => invoke("purchase_tickets", {}),
    get_order: () => invoke("get_order", {}),
    cancel_draft: () => invoke("cancel_draft", {}),
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
    get_order: "Get current order snapshot.",
    cancel_draft: "Cancel draft order before purchase.",
  };

  for (const name of names) {
    doc.modelContext.registerTool({
      name,
      description: descriptions[name] ?? name,
      inputSchema: { type: "object" },
      execute: (args) => tools[name]?.(args ?? {}) ?? { ok: false, error: "missing_handler" },
    });
  }

  return {
    registered: names,
    lane: "native",
    detail: `Registered ${names.length} tools on document.modelContext`,
  };
}
