import { USE_CASES } from "../lab/catalog.ts";
import { SuiteToolRuntime } from "../lab/runtime.ts";
import {
  ProtocolRunContext,
  wrapRegisteredToolExecute,
} from "../../../reliability-boundary/spine/protocolSpine.ts";

type ModelContextTool = {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
  execute: (args: Record<string, unknown>) => unknown;
};

type ModelContextDocument = Document & {
  modelContext?: {
    registerTool?: (tool: ModelContextTool) => void | Promise<void>;
  };
};

export type SuiteRegistration = {
  lane: "native" | "unavailable";
  registered: string[];
  detail: string;
  protocol: ProtocolRunContext;
};

export function registerUseCaseSuite(
  runtime: SuiteToolRuntime,
  doc: Document = document,
  options: { protocol?: ProtocolRunContext } = {},
): SuiteRegistration {
  const protocol = options.protocol ?? new ProtocolRunContext();
  const context = (doc as ModelContextDocument).modelContext;
  if (!context?.registerTool) {
    return {
      lane: "unavailable",
      registered: [],
      detail: "Native WebMCP is unavailable in this browser. The visible replay still works; registered-tool audit must fail closed.",
      protocol,
    };
  }

  const registered: string[] = [];
  for (const useCase of USE_CASES) {
    for (const tool of useCase.tools) {
      const scopedName = `${useCase.id}.${tool.name}`;
      context.registerTool({
        name: scopedName,
        title: `${useCase.eyebrow}: ${tool.title}`,
        description: `${tool.description} Simulated ${useCase.eyebrow.toLowerCase()} sandbox; no real external effect.`,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.readOnly },
        execute: wrapRegisteredToolExecute(
          scopedName,
          (args) => runtime.execute(useCase, tool.name, args ?? {}),
          protocol,
          { readOnly: tool.readOnly },
        ),
      });
      registered.push(scopedName);
    }
  }

  return {
    lane: "native",
    registered,
    detail: `${registered.length} typed tools registered across ${USE_CASES.length} simulated web applications via shared protocol spine.`,
    protocol,
  };
}
