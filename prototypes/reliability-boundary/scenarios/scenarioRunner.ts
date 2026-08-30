/**
 * Portable scenario runner — exercises PUBLIC plugin API only.
 * Pure functions; no DOM; synthetic adversity inputs.
 */

import {
  validateCall,
  rejectStaleConsequential,
  envelopeFromToolError,
  selectDiagnosisAction,
  newOperationId,
  reconcileAmbiguousCommit,
  decideRecovery,
  computeEpoch,
  beginEffect,
  markUnknown,
  PLUGIN_INVOKE_ORDER,
  type PluginMechanism,
  type DiagnosisAction,
  type RecoveryAction,
  type EffectRecord,
  type ObservedRuntime,
} from "../plugin/api.ts";
import type { ScenarioContract } from "./scenarioContract.ts";
import { allowsConsequentialFrom } from "./scenarioContract.ts";

export type RunnerMode = "off" | "exact-stage" | "full-stack";

export type AdversityKey =
  | "wrong_precondition_state"
  | "stale_capability_epoch"
  | "ambiguous_commit_after_timeout"
  | "missing_issue_id"
  | "duplicate_transition"
  | "execution_error";

/** Synthetic adversity payload — no domain store required. */
export type AdversityInput = {
  key: AdversityKey;
  tool: string;
  args: Record<string, unknown>;
  state: string;
  state_revision: number;
  expectedEpoch?: string;
  actualEpoch?: string;
  rawError?: string;
  observedRuntime?: ObservedRuntime;
  effectPrior?: EffectRecord | null;
  operationId?: string;
  observedAfterAmbiguity?: {
    state: string;
    order_id: string | null;
    receipt_id: string | null;
    committed_purchase_count: number;
  };
};

export type ScenarioStepResult = {
  mechanism: PluginMechanism | "passthrough";
  ok: boolean;
  detail: Record<string, unknown>;
};

export type ScenarioRunResult = {
  scenarioId: string;
  mode: RunnerMode;
  exactStage?: PluginMechanism;
  adversityKey: AdversityKey;
  steps: ScenarioStepResult[];
  blocked: boolean;
  diagnosisAction?: DiagnosisAction;
  recoveryAction?: RecoveryAction;
  operationId?: string;
};

function mechanismsForMode(
  mode: RunnerMode,
  exactStage?: PluginMechanism,
): PluginMechanism[] {
  switch (mode) {
    case "off":
      return [];
    case "exact-stage":
      return exactStage ? [exactStage] : [];
    case "full-stack":
      return [...PLUGIN_INVOKE_ORDER];
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

function buildAdversity(
  contract: ScenarioContract,
  key: AdversityKey,
): AdversityInput {
  const epoch = computeEpoch(contract.tools);
  const staleEpoch = computeEpoch([...contract.tools, "phantom_tool"]);

  switch (key) {
    case "wrong_precondition_state":
      return {
        key,
        tool: contract.consequentialTool,
        args: {},
        state: contract.initialStateId,
        state_revision: 0,
        expectedEpoch: epoch,
        actualEpoch: epoch,
      };
    case "stale_capability_epoch":
      return {
        key,
        tool: contract.consequentialTool,
        args: {},
        state: contract.preconditionStateId,
        state_revision: 2,
        expectedEpoch: epoch,
        actualEpoch: staleEpoch,
      };
    case "ambiguous_commit_after_timeout": {
      const opId = newOperationId("scenario");
      const prior = markUnknown(
        beginEffect({
          operation_id: opId,
          tool: contract.consequentialTool,
          state_revision_before: 3,
          now_ms: 1_000,
        }),
      );
      return {
        key,
        tool: contract.consequentialTool,
        args: {},
        state: contract.preconditionStateId,
        state_revision: 4,
        expectedEpoch: epoch,
        actualEpoch: epoch,
        effectPrior: prior,
        operationId: opId,
        observedAfterAmbiguity: {
          state: contract.preconditionStateId,
          order_id: null,
          receipt_id: null,
          committed_purchase_count: 0,
        },
      };
    }
    case "missing_issue_id":
      return {
        key,
        tool: "create_issue",
        args: {},
        state: contract.initialStateId,
        state_revision: 0,
      };
    case "duplicate_transition":
      return {
        key,
        tool: contract.consequentialTool,
        args: { target_state: "DONE" },
        state: "DONE",
        state_revision: 5,
        expectedEpoch: epoch,
        actualEpoch: epoch,
      };
    case "execution_error":
      return {
        key,
        tool: contract.consequentialTool,
        args: {},
        state: contract.preconditionStateId,
        state_revision: 1,
        rawError: "network_timeout",
        expectedEpoch: epoch,
        actualEpoch: epoch,
      };
    default: {
      const _exhaustive: never = key;
      return _exhaustive;
    }
  }
}

function defaultObservedRuntime(contract: ScenarioContract): ObservedRuntime {
  return {
    tools_include_purchase: contract.tools.includes(contract.consequentialTool),
    order_state: contract.preconditionStateId,
    order_id: null,
    receipt_id: null,
    total_aud: 120,
    budget_aud: 300,
    seat_ids: ["A1"],
    price_drift: false,
    seat_drift: false,
  };
}

function runMechanismStep(
  mechanism: PluginMechanism,
  contract: ScenarioContract,
  adversity: AdversityInput,
  operationId: string,
): ScenarioStepResult {
  switch (mechanism) {
    case "contract_conformance": {
      const result = validateCall({
        tool: adversity.tool,
        args: adversity.args,
        state: adversity.state,
      });
      return {
        mechanism,
        ok: result.ok,
        detail: {
          violations: result.violations,
          allowsConsequential: allowsConsequentialFrom(contract, adversity.state),
        },
      };
    }
    case "capability_freshness": {
      const decision = rejectStaleConsequential(
        adversity.tool,
        adversity.expectedEpoch,
        adversity.actualEpoch,
        [contract.consequentialTool],
      );
      return {
        mechanism,
        ok: decision.ok,
        detail: { code: decision.code, expected: decision.expected, actual: decision.actual },
      };
    }
    case "structured_semantics": {
      const error =
        adversity.rawError ??
        (adversity.key === "stale_capability_epoch"
          ? "stale_capability_epoch"
          : adversity.key === "wrong_precondition_state"
            ? "contract_violation"
            : "execution_error");
      const envelope = envelopeFromToolError({
        tool: adversity.tool,
        error,
        state: adversity.state,
        state_revision: adversity.state_revision,
      });
      return {
        mechanism,
        ok: true,
        detail: { category: envelope.category, owner: envelope.owner },
      };
    }
    case "diagnosis_policy": {
      const error =
        adversity.rawError ??
        (adversity.key === "stale_capability_epoch"
          ? "stale_capability_epoch"
          : adversity.key === "wrong_precondition_state"
            ? "contract_violation"
            : "execution_error");
      const envelope = envelopeFromToolError({
        tool: adversity.tool,
        error,
        state: adversity.state,
        state_revision: adversity.state_revision,
      });
      const decision = selectDiagnosisAction({ structuredFailure: envelope });
      return {
        mechanism,
        ok: true,
        detail: { action: decision.action, rationale: decision.rationale },
      };
    }
    case "effect_safety": {
      if (adversity.key === "ambiguous_commit_after_timeout" && adversity.observedAfterAmbiguity) {
        const reconcile = reconcileAmbiguousCommit({
          operation_id: operationId,
          observed: adversity.observedAfterAmbiguity,
          prior: adversity.effectPrior ?? null,
        });
        return {
          mechanism,
          ok: reconcile.ok,
          detail: { action: reconcile.action, rationale: reconcile.rationale },
        };
      }
      const op = newOperationId("probe");
      return {
        mechanism,
        ok: op.length > 0,
        detail: { sampleOperationId: op },
      };
    }
    case "state_recovery": {
      const observed = adversity.observedRuntime ?? defaultObservedRuntime(contract);
      const decision = decideRecovery(observed);
      return {
        mechanism,
        ok: true,
        detail: { action: decision.action, rationale: decision.rationale },
      };
    }
    default: {
      const _exhaustive: never = mechanism;
      return _exhaustive;
    }
  }
}

/**
 * Run a scenario against the plugin API under off / exact-stage / full-stack modes.
 */
export function runScenario(input: {
  contract: ScenarioContract;
  adversityKey: AdversityKey;
  mode: RunnerMode;
  exactStage?: PluginMechanism;
}): ScenarioRunResult {
  const { contract, adversityKey, mode, exactStage } = input;
  const adversity = buildAdversity(contract, adversityKey);
  const operationId = adversity.operationId ?? newOperationId("run");

  if (mode === "off") {
    return {
      scenarioId: contract.id,
      mode,
      adversityKey,
      steps: [{ mechanism: "passthrough", ok: true, detail: { skipped: true } }],
      blocked: false,
      operationId,
    };
  }

  const mechanisms = mechanismsForMode(mode, exactStage);
  const steps: ScenarioStepResult[] = [];
  let blocked = false;
  let diagnosisAction: DiagnosisAction | undefined;
  let recoveryAction: RecoveryAction | undefined;

  for (const mechanism of mechanisms) {
    const step = runMechanismStep(mechanism, contract, adversity, operationId);
    steps.push(step);

    if (!step.ok && (mechanism === "contract_conformance" || mechanism === "capability_freshness")) {
      blocked = true;
      if (mode === "full-stack") {
        break;
      }
    }

    if (mechanism === "diagnosis_policy" && typeof step.detail.action === "string") {
      diagnosisAction = step.detail.action as DiagnosisAction;
    }
    if (mechanism === "state_recovery" && typeof step.detail.action === "string") {
      recoveryAction = step.detail.action as RecoveryAction;
    }
  }

  return {
    scenarioId: contract.id,
    mode,
    exactStage,
    adversityKey,
    steps,
    blocked,
    diagnosisAction,
    recoveryAction,
    operationId,
  };
}

/** Run all oracle hooks for a contract in full-stack mode (smoke). */
export function runContractOracles(contract: ScenarioContract): ScenarioRunResult[] {
  return contract.oracleHooks
    .filter((h): h is typeof h & { adversityKey: AdversityKey } => Boolean(h.adversityKey))
    .map((hook) =>
      runScenario({
        contract,
        adversityKey: hook.adversityKey,
        mode: "full-stack",
      }),
    );
}
