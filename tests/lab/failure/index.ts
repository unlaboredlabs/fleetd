// The native runner's failure scenarios (spec §7), in run order, for testLab.ts to append after the M scenarios.
// They restart lab-b with overrides and put its defaults back; usage-limit comes last because the parking it causes
// holds lab-b's launches until its (90 s) reset.
import type { Lab } from "../harness.ts";
import { expiredLogin } from "./expiredLogin.ts";
import { idleResume } from "./idleResume.ts";
import { killMidTurn } from "./killMidTurn.ts";
import { overloaded } from "./overloaded.ts";
import { usageLimit } from "./usageLimit.ts";

export const FAILURE_SCENARIOS: ReadonlyArray<{ readonly name: string; readonly run: (lab: Lab) => Promise<void> }> = [
  { name: "kill-mid-turn", run: killMidTurn },
  { name: "resume", run: idleResume },
  { name: "overloaded", run: overloaded },
  { name: "expired-login", run: expiredLogin },
  { name: "usage-limit", run: usageLimit },
];
