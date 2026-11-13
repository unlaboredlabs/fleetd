// An agent card: the agent's live row from the agents view (role, task, how long, what it does now), a link that
// opens its work in the panel. One that isn't at work now shows its task's title and state as the hub has them
// (task_get): a task between the turns its own Monitor wakes is in no live list. A lead's says so from the last list.
import { Bot } from "lucide-react";
import type { AgentBlock, AgentRow, Task } from "../../../../shared/contracts";
import { CallError } from "../../../src/data/queries";
import { useData, useToolQuery } from "../../../src/data/react";
import { selectLiveAgents } from "../../../src/data/selectors";
import { Text, Truncate } from "../../../ui";
import { AgentRowLink } from "../../agents/AgentsPane";
import b from "./blocks.module.css";

const ALL = {} as const;

const isIt = (a: AgentBlock) => (row: AgentRow) =>
  a.taskId !== undefined
    ? row.taskId === a.taskId
    : a.threadRef !== undefined && row.threadRef?.threadId === a.threadRef.threadId && row.threadRef.machineId === a.threadRef.machineId;

/** A task's state in the card's words. */
export const taskStateText = (task: Pick<Task, "state" | "parked">): string => {
  if (task.parked !== undefined && (task.state === "running" || task.state === "idle")) return "Paused.";
  switch (task.state) {
    case "queued":
      return "Queued.";
    case "running":
      return "Running.";
    case "idle":
      return "Waiting for an answer.";
    case "done":
      return "Finished.";
    case "failed":
      return "Failed.";
    case "cancelled":
      return "Cancelled.";
  }
};

export function AgentCard({ agent }: { agent: AgentBlock }) {
  useToolQuery("agents_list", ALL);
  const live = useData((d) => selectLiveAgents(d)?.find((a) => isIt(agent)(a.row)));
  const known = useData((d) => (live === undefined ? d.agents?.find(isIt(agent)) : undefined));
  const taskId = agent.taskId;
  const task = useToolQuery("task_get", { taskId: taskId ?? "" }, { enabled: live === undefined && taskId !== undefined });
  if (live !== undefined) {
    return (
      <div className={b.card} data-block="agent">
        <AgentRowLink agent={live} />
      </div>
    );
  }
  const missing = task.error instanceof CallError && task.error.error.code === "not_found";
  const [title, state] =
    taskId === undefined
      ? [known?.title ?? "An agent", known === undefined ? "Not running now." : "Finished."]
      : task.data !== undefined
        ? [task.data.task.title, taskStateText(task.data.task)]
        : missing
          ? [`Agent ${taskId}`, "This hub has no such task."]
          : [`Agent ${taskId}`, task.error !== null ? "Its state can't be read now." : ""];
  return (
    <div className={b.card} data-block="agent">
      <div className={b.prTop}>
        <Bot className={b.icon} aria-hidden />
        <span className={b.prTitle}>
          <Truncate size="sm">{title}</Truncate>
          {state === "" ? null : (
            <Text size="xs" tone="quiet">
              {state}
            </Text>
          )}
        </span>
      </div>
    </div>
  );
}
