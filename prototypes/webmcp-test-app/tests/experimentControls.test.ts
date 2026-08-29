import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTROLS,
  allMechanismsOff,
  describeControls,
} from "../src/ui/experimentControls.ts";

describe("experiment controls", () => {
  it("defaults to baseline with all mechanisms off", () => {
    expect(DEFAULT_CONTROLS.condition).toBe("baseline");
    expect(allMechanismsOff(DEFAULT_CONTROLS.mechanisms)).toBe(true);
    expect(describeControls(DEFAULT_CONTROLS)).toContain("mechanisms=none");
  });
});
