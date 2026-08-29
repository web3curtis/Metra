import { describe, expect, it } from "vitest";
import { probeCodexAdapter } from "../src/harness/codexAgentAdapter.ts";

describe("codex adapter probe", () => {
  it("reports not_authenticated when CLI probe skipped and no keys", () => {
    const probe = probeCodexAdapter({ CODEX_SKIP_CLI_PROBE: "1" });
    expect(probe.status).toBe("not_authenticated");
  });

  it("reports ready when CODEX_AUTH_OK=1", () => {
    const probe = probeCodexAdapter({ CODEX_AUTH_OK: "1" });
    expect(probe.status).toBe("ready");
  });
});
