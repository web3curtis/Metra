import { describe, expect, it } from "vitest";
import { USE_CASES } from "../src/lab/catalog.ts";
import { labToolContracts, validateLabToolCall } from "../src/lab/labContracts.ts";
import {
  validateAgainstContract,
  getToolContract,
  validateOutput,
} from "../../reliability-boundary/contract/contractV0.ts";
import { ProtocolRunContext } from "../../reliability-boundary/spine/protocolSpine.ts";

describe("Stage 3 A contract transfer", () => {
  it("registers declarative contracts for all six lab domains without policy-core edits", () => {
    const contracts = labToolContracts();
    expect(Object.keys(contracts).length).toBe(24);
    for (const useCase of USE_CASES) {
      const action = useCase.tools.find((t) => !t.readOnly)!;
      const id = `${useCase.id}.${action.name}`;
      const blocked = validateLabToolCall(id, {});
      expect(blocked.ok).toBe(false);
      expect(blocked.violations.some((v) => v.code === "required_field")).toBe(true);
      const allowed = validateLabToolCall(id, {
        operation_id: "op_transfer_1",
        expected_revision: 1,
      });
      expect(allowed.ok).toBe(true);
      expect(allowed.effect_class).toBe("consequential_mutation");
    }
  });

  it("reuses the same neutral engine for ReliableRail and lab contracts", () => {
    const rail = getToolContract("purchase_tickets")!;
    const lab = labToolContracts()["commerce.create_order"]!;
    const protocol = new ProtocolRunContext();
    const railResult = validateAgainstContract(rail, {
      tool: rail.tool_id,
      args: {},
      state: "EMPTY",
      protocol,
    });
    const labResult = validateAgainstContract(lab, {
      tool: lab.tool_id,
      args: {},
      state: "READY",
      protocol,
    });
    expect(railResult.ok).toBe(false);
    expect(labResult.ok).toBe(false);
    expect(protocol.allEvents().every((e) => e.run_id === protocol.identities.run_id)).toBe(true);
    expect(protocol.allEvents().filter((e) => e.event_type === "contract_validate")).toHaveLength(2);
  });

  it("rejects malformed purchase success via postconditions", () => {
    const rail = getToolContract("purchase_tickets")!;
    const bad = validateOutput({
      tool: "purchase_tickets",
      ok: true,
      data: { order_id: "only-order" },
      contract: rail,
      state_after: "PURCHASED",
    });
    expect(bad.ok).toBe(false);
    expect(bad.violations.some((v) => v.code === "malformed_success")).toBe(true);
  });
});
