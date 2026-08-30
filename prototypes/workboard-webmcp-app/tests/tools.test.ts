import { describe, expect, it } from "vitest";
import { TOOL_INPUT_SCHEMAS, DEFAULT_FLAGS } from "../src/schemas.ts";
import { invokeTool, defaultBoard } from "../src/store.ts";

type R = { ok: boolean; data?: unknown; error?: string };
const norm = async (run: () => R) => { try { return await Promise.resolve(run()); } catch (e) { return { ok: false, error: String(e) }; } };

describe("WorkBoard registered handler simulation", () => {
  it("schemas include required fields and create_issue forwards title arg", async () => {
    const board = defaultBoard();
    const invoke = (_n: string, a: Record<string, unknown>) =>
      invokeTool(board, "create_issue", a, { flags: DEFAULT_FLAGS, adversity: "none", effects: new Map() });
    const tools = { create_issue: (a: Record<string, unknown>) => norm(() => invoke("create_issue", a ?? {})) };
    expect(TOOL_INPUT_SCHEMAS.create_issue).not.toEqual({ type: "object" });
    expect(JSON.stringify(TOOL_INPUT_SCHEMAS.create_issue)).toContain("title");
    expect(JSON.stringify(TOOL_INPUT_SCHEMAS.transition_issue)).toContain("issue_id");
    const r = await tools.create_issue({ title: "Portability G1" });
    expect(r.ok).toBe(true);
    expect(board.issues[0]?.title).toBe("Portability G1");
  });
});
