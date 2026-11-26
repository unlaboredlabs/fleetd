// An agent that isn't at work now, as the hub has it (task_get): its title, how it ended, its order, its PR and its
// last words. Where an agent's chip or link lands once the agent has finished, so the link never opens on an
// empty page. Read-only: there is nothing to steer or stop.
import { CallError } from "../../src/data/queries";
import { useToolQuery } from "../../src/data/react";
import { Button, EmptyState, Text } from "../../ui";
import { prOfUrl } from "../activity/model";
import { taskStateText } from "../chat/blocks/AgentCard";
import { Message } from "../chat/text";
import { RefChip } from "../refs/RefChip";
import { navigate } from "../shell/navigation";
import { panelRoute, type ProjectKey } from "../shell/routes";
import s from "./agents.module.css";

export function FinishedAgent({ project, taskId }: { project: ProjectKey; taskId: string }) {
  const read = useToolQuery("task_get", { taskId });
  const task = read.data?.task;
  if (task === undefined) {
    if (read.error instanceof CallError && read.error.error.code === "not_found") {
      return (
        <div className={s.workBody} data-screen="agents.work">
          <EmptyState title="This agent isn’t here">The workspace has no such agent any more.</EmptyState>
        </div>
      );
    }
    return read.error !== null ? (
      <div className={s.workBody} data-screen="agents.work">
        <EmptyState title="This agent isn’t running now">Its result can’t be read now. The chat says how it went.</EmptyState>
      </div>
    ) : (
      <div className={s.workBody} aria-busy="true" />
    );
  }
  const result = task.result;
  const pr = prOfUrl(task.pr ?? result?.prUrl);
  return (
    <section className={s.workBody} aria-label={task.title} data-screen="agents.work.finished">
      <div className={s.workHead}>
        <span className={s.headState}>
          <Text size="xs" tone="quiet">
            {taskStateText(task).replace(/\.$/u, "")}
          </Text>
          <span className={s.order}>
            <RefChip of={{ id: task.workstreamId, kind: "order", opens: false }} project={task.projectRef} />
          </span>
        </span>
        <Text as="h2" size="md" strong>
          {task.title}
        </Text>
        {/* Its PR, not its branch: a branch's name carries the agent's id. */}
        {pr === undefined ? null : (
          <span className={s.meta}>
            <Button variant="secondary" size="sm" onClick={() => navigate(panelRoute(project, { tab: "prs", pr }))}>
              {`PR #${String(pr.number)}`}
            </Button>
          </span>
        )}
      </div>
      <div className={s.lastWords}>
        {result === undefined || result.tail.trim() === "" ? (
          <Text size="sm" tone="quiet">
            It left no result.
          </Text>
        ) : (
          <>
            <Text size="xs" tone="faint">
              What it said last
            </Text>
            <Message text={result.tail} project={project} />
          </>
        )}
      </div>
    </section>
  );
}
