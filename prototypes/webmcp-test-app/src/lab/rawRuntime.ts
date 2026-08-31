/**
 * Raw WebMCP baseline: the same six applications implemented the way a site
 * ships WebMCP tools today — a name, a JSON schema, and a handler that does the
 * thing it is asked to do.
 *
 * There is no contract registry, no precondition state, no operation identity and
 * no outcome normalization here, because a plain WebMCP registration has nowhere
 * to put them. This is the "before" side of the published comparison and must
 * stay deliberately ordinary; it is not a straw man, it is the default.
 */

import type { UseCase } from "./catalog.ts";

export type RawResult = {
  ok: boolean;
  error?: string;
  data?: Record<string, unknown>;
};

export class RawSuiteRuntime {
  private revision = 1;
  private effects: Array<{ id: string; tool: string; args: Record<string, unknown> }> = [];

  effectCount(): number {
    return this.effects.length;
  }

  reset(): void {
    this.revision = 1;
    this.effects = [];
  }

  execute(useCase: UseCase, toolName: string, args: Record<string, unknown>): RawResult {
    const tool = useCase.tools.find((item) => item.name === toolName);
    if (!tool) return { ok: false, error: "unknown_tool" };

    if (tool.readOnly) {
      return {
        ok: true,
        data: {
          use_case: useCase.id,
          revision: this.revision,
          ...(tool.observation ?? {}),
          simulated: true,
        },
      };
    }

    // A plain WebMCP write tool commits when called. Nothing here knows whether
    // the agent looked at anything first.
    const id = `${useCase.id}_${this.effects.length + 1}`;
    this.effects.push({ id, tool: toolName, args });
    this.revision += 1;
    return {
      ok: true,
      data: {
        id,
        status: "committed",
        revision: this.revision,
        effect_count: this.effects.length,
        ...useCase.effectRecord,
        simulated: true,
      },
    };
  }
}

type ModelContextTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
  execute: (args: Record<string, unknown>) => unknown;
};

type ModelContextDocument = Document & {
  modelContext?: { registerTool?: (tool: ModelContextTool) => void | Promise<void> };
};

export function registerRawSuite(
  runtime: RawSuiteRuntime,
  doc: Document,
  useCases: UseCase[],
): string[] {
  const context = (doc as ModelContextDocument).modelContext;
  if (!context?.registerTool) return [];
  const registered: string[] = [];
  for (const useCase of useCases) {
    for (const tool of useCase.tools) {
      const scopedName = `${useCase.id}.${tool.name}`;
      context.registerTool({
        name: scopedName,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.readOnly },
        execute: (args) => runtime.execute(useCase, tool.name, args ?? {}),
      });
      registered.push(scopedName);
    }
  }
  return registered;
}
