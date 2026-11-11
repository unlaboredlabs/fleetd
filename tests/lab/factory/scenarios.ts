// The factory lab's scenarios by name: what run.ts runs, each on a factory of its own (kit.ts), and what tests/compare
// runs on a team of whatever it is pointed at.
import { agentMessages } from "./agentMessages.ts";
import { leadWake } from "./leadWake.ts";
import { selfHealing } from "./selfHealing.ts";
import { throughput } from "./throughput.ts";

export const SCENARIOS = [
  { name: "throughput", run: throughput },
  { name: "self-healing", run: selfHealing },
  { name: "lead-wake", run: leadWake },
  { name: "agent-messages", run: agentMessages },
] as const;
