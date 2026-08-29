/**
 * Codex agent adapter spike.
 * Live CLI: Codex is available when `codex login status` reports logged in.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type CodexAdapterStatus =
  | "not_authenticated"
  | "ready"
  | "unsupported_in_this_environment";

export type CodexAdapterProbe = {
  engine: "codex-cli-v0";
  status: CodexAdapterStatus;
  detail: string;
};

function tryCodexLoginStatus(): boolean {
  try {
    const out = execFileSync("codex", ["login", "status"], {
      encoding: "utf8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return /logged in/i.test(out);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stderr =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr?: unknown }).stderr ?? "")
        : "";
    const combined = `${message}\n${stderr}`;
    return /logged in/i.test(combined);
  }
}

function hasLocalCodexAuthFile(): boolean {
  try {
    const home = process.env.HOME;
    if (!home) return false;
    return existsSync(join(home, ".codex", "auth.json"));
  } catch {
    return false;
  }
}

/**
 * Probe whether Codex can be launched. Does not start a purchase session.
 */
export function probeCodexAdapter(env: NodeJS.ProcessEnv = process.env): CodexAdapterProbe {
  if (env.CODEX_API_KEY || env.OPENAI_API_KEY || env.CODEX_AUTH_OK === "1") {
    return {
      engine: "codex-cli-v0",
      status: "ready",
      detail: "Auth marker present in environment.",
    };
  }
  if (env.CODEX_SKIP_CLI_PROBE === "1") {
    return {
      engine: "codex-cli-v0",
      status: "not_authenticated",
      detail: "CLI probe skipped (CODEX_SKIP_CLI_PROBE=1).",
    };
  }
  if (tryCodexLoginStatus() || hasLocalCodexAuthFile()) {
    return {
      engine: "codex-cli-v0",
      status: "ready",
      detail: tryCodexLoginStatus()
        ? "codex login status reports Logged in."
        : "Found ~/.codex/auth.json (CLI status probe inconclusive).",
    };
  }
  return {
    engine: "codex-cli-v0",
    status: "not_authenticated",
    detail:
      "Codex CLI not authenticated. Ask CEO to run `codex login`, or set CODEX_AUTH_OK=1.",
  };
}

/**
 * Placeholder for a live Codex-driven session. Throws until tool bridge is wired.
 */
export async function runCodexPlannerSession(_options: {
  taskPrompt: string;
}): Promise<never> {
  const probe = probeCodexAdapter();
  if (probe.status !== "ready") {
    throw new Error(`codex_adapter_blocked: ${probe.detail}`);
  }
  throw new Error(
    "codex_adapter_not_implemented: auth ready but live WebMCP tool bridge not wired yet",
  );
}
