// An agent card: the agent's live row from the agents view (role, task, how long, what it does now), a link that
// opens its work in the panel. One that has stopped says so, from the last list the hub gave.
import { Bot } from "lucide-react";
import type { AgentBlock, AgentRow } from "../../../../shared/contracts";
import { useData } from "../../../src/data/react";
import { selectLiveAgents } from "../../../src/data/selectors";
import { Text, Truncate } from "../../../ui";
import { AgentRowLink } from "../../agents/AgentsPane";
import b from "./blocks.module.css";

const isIt = (a: AgentBlock) => (row: AgentRow) =>
  a.taskId !== undefined
    ? row.taskId === a.taskId
    : a.threadRef !== undefined && row.threadRef?.threadId === a.threadRef.threadId && row.threadRef.machineId === a.threadRef.machineId;

export function AgentCard({ agent }: { agent: AgentBlock }) {
  const live = useData((d) => selectLiveAgents(d)?.find((a) => isIt(agent)(a.row)));
  const known = useData((d) => (live === undefined ? d.agents?.find(isIt(agent)) : undefined));
  if (live !== undefined) {
    return (
      <div className={b.card} data-block="agent">
        <AgentRowLink agent={live} />
      </div>
    );
  }
  return (
    <div className={b.card} data-block="agent">
      <div className={b.prTop}>
        <Bot className={b.icon} aria-hidden />
        <span className={b.prTitle}>
          <Truncate size="sm">{known?.title ?? "An agent"}</Truncate>
          <Text size="xs" tone="quiet">
            {known === undefined ? "Not running now." : "Finished."}
          </Text>
        </span>
      </div>
    </div>
  );
}
