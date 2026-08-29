/**
 * One-way Critiqor event export. Never mutates WebMCP authoritative artifacts.
 */

export type ReliableRailEvent = {
  sequence: number;
  timestamp: string;
  component: string;
  stage: string;
  event_type: string;
  payload: Record<string, unknown>;
};

export type CritiqorRuntimeEvent = {
  event_type: string;
  timestamp: string;
  source_layer: string;
  payload: Record<string, unknown>;
};

export function mapEventToCritiqor(event: ReliableRailEvent): CritiqorRuntimeEvent {
  let eventType = event.event_type;
  if (eventType === "tool_result") {
    const ok = event.payload.ok;
    eventType = ok === false ? "error_event" : "tool_output";
  } else if (eventType === "tool_call") {
    eventType = "tool_call";
  }

  return {
    event_type: eventType,
    timestamp: event.timestamp,
    source_layer: "reliablerail_adapter",
    payload: {
      sequence: event.sequence,
      component: event.component,
      stage: event.stage,
      original_event_type: event.event_type,
      ...event.payload,
    },
  };
}

export function exportEventsToCritiqorJsonl(events: ReliableRailEvent[]): string {
  return events.map((e) => JSON.stringify(mapEventToCritiqor(e))).join("\n") + (events.length ? "\n" : "");
}
