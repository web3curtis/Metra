import { USE_CASES } from "../lab/catalog.ts";
import { SuiteToolRuntime } from "../lab/runtime.ts";
import {
  ProtocolRunContext,
  wrapRegisteredToolExecute,
} from "../../../reliability-boundary/spine/protocolSpine.ts";
import { BoundarySession, createEnforcedHandler } from "./enforcedBoundary.ts";

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
  session: BoundarySession;
};

export function registerUseCaseSuite(
  runtime: SuiteToolRuntime,
  doc: Document = document,
  options: { protocol?: ProtocolRunContext; session?: BoundarySession } = {},
): SuiteRegistration {
  const protocol = options.protocol ?? new ProtocolRunContext();
  const session = options.session ?? new BoundarySession();
  const context = (doc as ModelContextDocument).modelContext;
  if (!context?.registerTool) {
    return {
      lane: "unavailable",
      registered: [],
      detail: "Native WebMCP is unavailable in this browser. The visible replay still works; registered-tool audit must fail closed.",
      protocol,
      session,
    };
  }

  const registered: string[] = [];
  for (const useCase of USE_CASES) {
    for (const tool of useCase.tools) {
      const scopedName = `${useCase.id}.${tool.name}`;
      const enforced = createEnforcedHandler({
        useCase,
        tool,
        session,
        protocol,
        handler: (args) => runtime.execute(useCase, tool.name, args ?? {}),
      });
      context.registerTool({
        name: scopedName,
        title: `${useCase.eyebrow}: ${tool.title}`,
        description: `${tool.description} Simulated ${useCase.eyebrow.toLowerCase()} sandbox; no real external effect.`,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.readOnly },
        execute: wrapRegisteredToolExecute(scopedName, enforced, protocol, {
          readOnly: tool.readOnly,
          isReconcileTool: tool.role === "reconcile",
        }),
      });
      registered.push(scopedName);
    }
  }

  return {
    lane: "native",
    registered,
    detail: `${registered.length} typed tools registered across ${USE_CASES.length} simulated web applications behind one A–D2 enforcement boundary.`,
    protocol,
    session,
  };
}
