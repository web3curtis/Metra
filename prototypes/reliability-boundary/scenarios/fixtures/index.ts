import { RELIABLERAIL_FIXTURE } from "./reliablerail.fixture.ts";
import { WORKBOARD_FIXTURE } from "./workboard.fixture.ts";
import { DOCUFLOW_FIXTURE } from "./docuflow.fixture.ts";
import type { ScenarioContract } from "../scenarioContract.ts";

export const ALL_SCENARIO_FIXTURES: ScenarioContract[] = [
  RELIABLERAIL_FIXTURE,
  WORKBOARD_FIXTURE,
  DOCUFLOW_FIXTURE,
];

export { RELIABLERAIL_FIXTURE, WORKBOARD_FIXTURE, DOCUFLOW_FIXTURE };
