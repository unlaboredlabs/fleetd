// An agent that isn't at work now, as the workspace kept it: how it ended and how long it ran, its order, its PR, what
// it was told, its final report, the files it changed (each opening its diff, from its PR), its commits, its screens'
// recordings and its step log, read-only. Where an agent's chip, link or History row lands once it has finished, so
// the record of what it did stays after it ends. Nothing to steer or stop.
import { ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import type { DiffLine, Task, TaskFile, WorkStep } from "../../../shared/contracts";
import { changeStat, changeTotals, endedWord, fileParts, ranFor } from "../../../shared/finished";
import { actionLabel } from "../../../shared/steps";
import { CallError } from "../../src/data/queries";
import { projectKey } from "../../src/data/store";
import { useData, useToolPages, useToolQuery } from "../../src/data/react";
import { Button, cx, EmptyState, Markdown, ROLE_WORD, Text, Truncate } from "../../ui";
import { prOfUrl } from "../activity/model";
import { roleWords } from "../chat/told";
import { ToldPanel } from "../chat/ToldPanel";
import { Message } from "../chat/text";
import { MiddleCut } from "../live/parts";
import { FEATURE } from "../sessions/hub";
import { navigate } from "../shell/navigation";
import { panelRoute, type PrKey, type ProjectKey } from "../shell/routes";
import { RolePill } from "./parts";
import { StepRow } from "./StepRow";
import s from "./agents.module.css";
import f from "./finished.module.css";

const ROLE = { write: "implementer", read: "reader", review: "reviewer" } as const;
const TONE = { Finished: "success", Failed: "danger", Stopped: "quiet" } as const;
/**
 * Steps a page of its log reads; earlier ones a page at a time. Not the live page's 40: a paged read and a plain one of
 * the same input share a cache entry, and hold different shapes.
 */
const STEP_PAGE = 30;

/**
 * The agent `id` names ("machine/project/lane") once it isn't at work: its task's record. A lane that isn't a task's
 * id is looked up in the workspace's rows, which keep an ended agent's task; with none, there is no record to show.
 */
export function EndedAgent({ id, stopped }: { id: string; stopped: boolean }) {
  const [machineId = "", projectId = "", lane = ""] = id.split("/");
  const listed = useData((st) => st.agents?.find((a) => `${projectKey(a.projectRef)}/${a.laneId}` === id)?.taskId);
  const taskId = /^T[1-9]\d*$/u.test(lane) ? lane : listed;
  if (taskId === undefined) {
    return stopped ? (
      <div className={s.workBody} data-screen="agents.work">
        <EmptyState title="Stopped" />
      </div>
    ) : (
      <div className={s.workBody} data-screen="agents.work">
        <EmptyState title="This agent isn’t running now">It finished, or was stopped. The chat says how it went.</EmptyState>
      </div>
    );
  }
  return <FinishedAgent project={{ machineId, projectId }} taskId={taskId} stopped={stopped} />;
}

/** `stopped`: you stopped it here a moment ago; it says so at once, before the workspace's record of it is read. */
export function FinishedAgent({ project, taskId, stopped = false }: { project: ProjectKey; taskId: string; stopped?: boolean }) {
  const read = useToolQuery("task_get", { taskId });
  const task = read.data?.task;
  // Read before the stop reached the workspace, it still says running: the record waits for the stop.
  const settled = task !== undefined && (!stopped || endedWord(task.state) !== undefined);
  if (!settled && stopped) {
    return (
      <div className={s.workBody} data-screen="agents.work">
        <EmptyState title="Stopped" />
      </div>
    );
  }
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
      <div className={s.workBody} aria-busy="true" data-screen="agents.work" />
    );
  }
  return <Record project={project} task={task} />;
}

function Record({ project, task }: { project: ProjectKey; task: Task }) {
  const [told, setTold] = useState(false);
  const result = task.result;
  const pr = prOfUrl(task.pr ?? result?.prUrl);
  const ended = endedWord(task.state);
  const ran = ranFor(task);
  const thread = task.threadRef;
  const order = useToolQuery("order_get", { workstreamId: task.workstreamId }).data?.order.title;
  const bot = useData((st) => st.projects[projectKey(task.projectRef)]?.title ?? "");
  return (
    <section className={s.workBody} aria-label={task.title} data-screen="agents.work.finished">
      <div className={s.workHead}>
        <span className={s.headState}>
          <Text size="xs" tone={ended === undefined ? "quiet" : TONE[ended]} strong={ended === "Failed"}>
            {ended ?? "Not running"}
          </Text>
          {ran === undefined ? null : (
            <Text size="xs" tone="quiet" className={f.ran}>
              {`ran ${ran}`}
            </Text>
          )}
          <RolePill role={ROLE[task.kind]} />
          <span className={s.order}>
            {order === undefined ? null : (
              <Truncate size="xs" tone="quiet">
                {order}
              </Truncate>
            )}
          </span>
        </span>
        <Text as="h2" size="md" strong>
          {task.title}
        </Text>
        <span className={s.meta}>
          {/* Its PR, not its branch: a branch's name carries the agent's id. */}
          {pr === undefined ? null : (
            <Button variant="secondary" size="sm" onClick={() => navigate(panelRoute(project, { tab: "prs", pr }))}>
              {`PR #${String(pr.number)}`}
            </Button>
          )}
          {thread === undefined ? null : (
            <Button variant="quiet" size="sm" onClick={() => setTold(true)}>
              What it was told
            </Button>
          )}
          <Replays project={project} taskId={task.taskId} />
        </span>
      </div>
      <div className={cx(s.lastWords, f.record)}>
        <Group label="Report">
          {result === undefined || result.tail.trim() === "" ? (
            <Text size="sm" tone="quiet">
              It left no report.
            </Text>
          ) : (
            <div className={f.report}>
              <Message text={result.tail} project={project} />
            </div>
          )}
        </Group>
        <Files task={task} pr={pr} />
        {result?.commits === undefined || result.commits.length === 0 ? null : (
          <Group label="Commits" count={String(result.commits.length)}>
            <ul className={f.list}>
              {result.commits.map((c) => (
                <li key={c.sha} className={f.commit}>
                  <Text size="xs" tone="faint" className={f.sha}>
                    {c.sha}
                  </Text>
                  <Truncate size="sm" expand="none">
                    {c.subject}
                  </Truncate>
                </li>
              ))}
            </ul>
          </Group>
        )}
        {thread === undefined ? null : <Steps thread={thread} report={result?.tail} />}
      </div>
      <ToldPanel
        open={told && thread !== undefined ? { thread, name: roleWords(ROLE[task.kind]), who: { project: bot, role: ROLE_WORD[ROLE[task.kind]] } } : undefined}
        projectRef={task.projectRef}
        onClose={() => setTold(false)}
      />
    </section>
  );
}

/** A quiet label over what it groups, with a count beside it when it has one. */
function Group({ label, count, children }: { label: string; count?: string | undefined; children: React.ReactNode }) {
  return (
    <section className={cx(s.orderGroup, f.group)} aria-label={label}>
      <span className={f.label}>
        <Text size="xs" tone="faint">
          {label}
        </Text>
        {count === undefined ? null : (
          <Text size="xs" tone="faint" className={f.count}>
            {count}
          </Text>
        )}
      </span>
      {children}
    </section>
  );
}

/** Its screens' recordings: Replay opens the newest in Screens; more than one lists each. */
function Replays({ project, taskId }: { project: ProjectKey; taskId: string }) {
  const on = useData((st) => st.features.includes(FEATURE));
  const rows = useToolQuery("browser_sessions", { projectRef: { machineId: project.machineId, projectId: project.projectId } }, { enabled: on }).data?.sessions;
  const recorded = useMemo(() => (rows ?? []).filter((r) => r.taskId === taskId && (r.files ?? []).length > 0), [rows, taskId]);
  const newest = recorded[0];
  if (newest === undefined) return null;
  return (
    <Button variant="quiet" size="sm" onClick={() => navigate(panelRoute(project, { tab: "sessions", session: newest.sessionId }))}>
      {recorded.length === 1 ? "Replay its screen" : `Replay its screens (${String(recorded.length)})`}
    </Button>
  );
}

/** The files it changed, as the workspace read them at its end, else its PR's; with its PR, each opens its diff. */
function Files({ task, pr }: { task: Task; pr: PrKey | undefined }) {
  const kept = task.result?.files;
  const repo = pr?.repo ?? null;
  // Paged, as the PR's Changes reads it (DiffPane): the same cache entry, in the same shape.
  const fromPr = useToolPages("pr_files", { repo: repo ?? "", number: pr?.number ?? 0 }, (page) => (page.nextOffset === undefined ? undefined : { offset: page.nextOffset }), {
    enabled: (kept === undefined || kept.length === 0) && pr !== undefined && repo !== null,
  });
  const files: readonly TaskFile[] = kept !== undefined && kept.length > 0 ? kept : (fromPr.data?.pages[0]?.files ?? []);
  const [open, setOpen] = useState<string>();
  if (files.length === 0) return null;
  const totals = changeTotals(files);
  const diffable = pr !== undefined && repo !== null;
  return (
    <Group label="Files changed" count={[String(files.length), changeStat(totals.additions, totals.deletions)].filter((x) => x !== "").join(" · ")}>
      <ul className={f.list}>
        {files.map((file) => {
          const { name, dir } = fileParts(file.path);
          const stat = changeStat(file.additions, file.deletions);
          const shown = open === file.path;
          const line = (
            <>
              <span className={f.fileName}>
                <Truncate size="sm" expand="none">
                  {name}
                </Truncate>
                {dir === "" ? null : (
                  <span className={f.dir}>
                    <MiddleCut text={dir} />
                  </span>
                )}
              </span>
              <span className={f.stat}>
                {file.additions > 0 ? <span className={f.add}>{`+${String(file.additions)}`}</span> : null}
                {file.deletions > 0 ? <span className={f.del}>{`−${String(file.deletions)}`}</span> : null}
                {stat === "" ? <span className={f.dir}>binary</span> : null}
              </span>
            </>
          );
          return (
            <li key={file.path}>
              {diffable ? (
                <button type="button" className={f.file} aria-expanded={shown} title={file.path} onClick={() => setOpen(shown ? undefined : file.path)}>
                  <ChevronRight aria-hidden className={cx(f.chevron, shown && f.chevronOpen)} />
                  {line}
                </button>
              ) : (
                <div className={cx(f.file, f.still)} title={file.path}>
                  {line}
                </div>
              )}
              {shown && diffable ? <FileDiff repo={repo} number={pr.number} path={file.path} /> : null}
            </li>
          );
        })}
      </ul>
    </Group>
  );
}

/** One file's diff from its PR, its first lines; the PR's Changes has the rest. */
function FileDiff({ repo, number, path }: { repo: string; number: number; path: string }) {
  const read = useToolQuery("pr_diff", { repo, number, path, limit: 200 });
  const out = read.data;
  if (out === undefined) {
    return read.error !== null ? (
      <Text size="xs" tone="quiet" className={f.diffNote}>
        Its diff can’t be read now.
      </Text>
    ) : (
      <div className={f.diff} aria-busy="true" />
    );
  }
  if (out.noDiff === true || out.lines.length === 0) {
    return (
      <Text size="xs" tone="quiet" className={f.diffNote}>
        GitHub shows no diff for this file.
      </Text>
    );
  }
  return (
    <div className={f.diff} role="region" aria-label={`Changes to ${fileParts(path).name}`}>
      {out.lines.map((l, i) => (
        <DiffRow key={i} line={l} />
      ))}
      {out.nextOffset === undefined ? null : (
        <Text size="xs" tone="quiet" className={f.diffNote}>
          {`${String(out.total - out.lines.length)} more lines in the PR’s Changes.`}
        </Text>
      )}
    </div>
  );
}

function DiffRow({ line }: { line: DiffLine }) {
  if (line.kind === "hunk") return <div className={f.hunk}>{line.text}</div>;
  const sign = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
  return (
    <div className={cx(f.line, line.kind === "add" && f.lineAdd, line.kind === "del" && f.lineDel)}>
      <span className={f.sign} aria-hidden>
        {sign}
      </span>
      <span className={f.code}>{line.text}</span>
    </div>
  );
}

/** Its step log as the workspace kept it, oldest first; earlier steps a page at a time. */
function Steps({ thread, report }: { thread: { machineId: string; threadId: string }; report: string | undefined }) {
  const pages = useToolPages("agent_work", { machineId: thread.machineId, threadId: thread.threadId, limit: STEP_PAGE }, (page) =>
    page.before === undefined ? undefined : { before: page.before },
  );
  // Its last words are the report above: the log doesn't say them twice.
  const steps = useMemo(() => {
    const all = [...(pages.data?.pages ?? [])].reverse().flatMap((p) => p.steps);
    const last = all.at(-1);
    return last?.kind === "message" && last.role === "assistant" && report !== undefined && report.trim().endsWith(last.text.trim().slice(-200)) ? all.slice(0, -1) : all;
  }, [pages.data, report]);
  return (
    <Group label="Steps">
      {pages.data === undefined ? (
        pages.error !== null ? (
          <Text size="sm" tone="quiet">
            Its steps can’t be read now.
          </Text>
        ) : (
          <div className={f.stepsLoading} aria-busy="true" aria-label="Loading its steps" />
        )
      ) : steps.length === 0 ? (
        <Text size="sm" tone="quiet">
          No steps kept.
        </Text>
      ) : (
        <div className={f.steps}>
          {pages.hasNextPage ? (
            <Button variant="quiet" size="sm" className={f.earlier} disabled={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
              {pages.isFetchingNextPage ? "Reading…" : "Earlier steps"}
            </Button>
          ) : null}
          {steps.map((step) => (
            <FinishedStep key={step.id} step={step} />
          ))}
        </div>
      )}
    </Group>
  );
}

/** One kept step, read-only: what it said, or what it did in plain words (StepRow), the command or path on a click. */
function FinishedStep({ step }: { step: WorkStep }) {
  if (step.kind === "message") {
    if (step.role !== "assistant") {
      return (
        <div className={cx(s.message, s.told)}>
          <Text size="xs" tone="quiet">
            {step.role === "user" ? "Told" : "Note"}
          </Text>
          <Truncate size="sm" tone="quiet" lines={3} expand="inline">
            {step.text}
          </Truncate>
        </div>
      );
    }
    return (
      <div className={s.message}>
        <Markdown source={step.text} />
      </div>
    );
  }
  const label = actionLabel(step.action);
  return label === undefined ? null : <StepRow label={label} output={step.action.outputTail} />;
}
