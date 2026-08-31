/**
 * Domain adapter: declarative contracts for the six lab surfaces.
 * Uses the neutral A engine; does not embed policy branches on domain nouns.
 */

import type { ToolContract } from "../../../reliability-boundary/contract/contractV0.ts";
import { validateAgainstContract } from "../../../reliability-boundary/contract/contractV0.ts";
import { USE_CASES } from "./catalog.ts";

export function labToolContracts(): Record<string, ToolContract> {
  const out: Record<string, ToolContract> = {};
  for (const useCase of USE_CASES) {
    for (const tool of useCase.tools) {
      const tool_id = `${useCase.id}.${tool.name}`;
      out[tool_id] = {
        tool_id,
        contract_version: "a-v1-lab",
        purpose: tool.description,
        effect_class: tool.readOnly ? "read" : "consequential_mutation",
        required_args: tool.readOnly ? [] : ["operation_id", "expected_revision"],
        requires_confirmation: !tool.readOnly,
        freshness_dependencies: tool.readOnly
          ? ["state_revision"]
          : ["capability_epoch", "document_epoch", "state_revision"],
        postconditions: tool.readOnly ? [] : ["operation_id"],
        failure_categories: [
          "invalid_input_or_precondition",
          "stale_capability_or_state",
          "execution_failure",
          "ambiguous_effect",
          "malformed_success",
        ],
        retry_safe: tool.readOnly,
        unknown_field_policy: tool.readOnly ? "ignore" : "reject",
      };
    }
  }
  return out;
}

export function validateLabToolCall(
  tool_id: string,
  args: Record<string, unknown>,
  state = "READY",
): ReturnType<typeof validateAgainstContract> {
  const contracts = labToolContracts();
  const contract = contracts[tool_id];
  if (!contract) {
    return {
      ok: false,
      violations: [{ code: "missing_contract", message: "no declarative contract registered for tool" }],
    };
  }
  return validateAgainstContract(contract, { tool: tool_id, args, state });
}
