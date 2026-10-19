// The order's left pane: its agents (each opens its steer box), its PRs, and what "done" means for it.

import { CheckCircle2, Circle, CircleAlert, CircleX } from "lucide-react";
import { cx, RoleTag, StatusChip, Text, Truncate, type StatusTone } from "../../ui";
import type { AgentLane, CheckSpec, Claim, LaneStatus, PrRef } from "./contracts";
import { doneRows, doneSummary, type CheckState } from "./doneWhen";
import { shortModel } from "./format";
import { activityLine, prStage, prTone } from "./lanes";
import s from "./order.module.css";

const STATUS: Readonly<Record<LaneStatus, StatusTone>> = {
  queued: "quiet",
  starting: "working",
  working: "working",
  waiting: "needs-you",
  parked: "quiet",
  stalled: "needs-you",
  idle: "idle",
  done: "done",
  failed: "failed",
  cancelled: "idle",
};

export function ActivityText({ lane }: { lane: AgentLane }) {
  const line = activityLine(lane);
  const tone = line.tone === "loud" ? s.loud : line.tone === "danger" ? s.danger : "";
  return (
    <>
      <span className={cx(s.activityWords, tone)}>{line.words}</span>
      {line.machine ? (
        <Truncate size="sm" mono tone="quiet" expand="none">
          {line.machine}
        </Truncate>
      ) : null}
    </>
  );
}

function Lane({ lane, onOpen }: { lane: AgentLane; onOpen: (lane: AgentLane) => void }) {
  const meta = [lane.model ? shortModel(lane.model) : undefined, lane.effort].filter(Boolean).join(" · ");
  return (
    <button type="button" className={s.lane} onClick={() => onOpen(lane)} aria-label={`Steer ${lane.taskId ?? lane.title}`} data-lane={lane.laneId}>
      <RoleTag role={lane.role} width={88} />
      <span className={s.laneHead}>
        <Text size="sm" mono tone="quiet">
          {lane.taskId ?? ""}
        </Text>
        <Truncate expand="none">{lane.title}</Truncate>
        {meta ? (
          <Text size="xs" tone="quiet" className={cx(s.laneModel)}>
            {meta}
          </Text>
        ) : null}
      </span>
      <span className={s.laneMeta}>
        <StatusChip tone={STATUS[lane.status]}>{lane.status}</StatusChip>
      </span>
      <span className={s.laneActivity}>
        <ActivityText lane={lane} />
        {lane.branch ? (
          <Truncate size="sm" mono tone="quiet" expand="none">
            {lane.branch}
          </Truncate>
        ) : null}
      </span>
    </button>
  );
}

function Section({ label, detail }: { label: string; detail?: string }) {
  return (
    <div className={s.section}>
      <span className={s.sectionLabel}>{label}</span>
      {detail ? (
        <Text size="xs" tone="quiet">
          {detail}
        </Text>
      ) : null}
    </div>
  );
}

const MARK: Readonly<Record<CheckState, { Icon: typeof Circle; label: string }>> = {
  pending: { Icon: Circle, label: "Not checked yet" },
  passed: { Icon: CheckCircle2, label: "Passed" },
  failed: { Icon: CircleX, label: "Failed" },
  error: { Icon: CircleAlert, label: "Could not run" },
};

export function DoneWhen({ checks, claim }: { checks: readonly CheckSpec[] | undefined; claim: Claim | undefined }) {
  if (checks === undefined) {
    return (
      <section data-screen="order.done-when">
        <Section label="Done when" />
        <Text size="xs" tone="quiet">
          A draft: the lead hasn’t frozen the brief yet.
        </Text>
      </section>
    );
  }
  const rows = doneRows(checks, claim);
  return (
    <section data-screen="order.done-when">
      <Section label="Done when" detail={doneSummary(rows)} />
      {rows.map((r) => {
        const { Icon, label } = MARK[r.state];
        return (
          <div key={r.index} className={s.check} data-check={r.state}>
            <span className={cx(s.checkMark, s[r.state])} role="img" aria-label={label}>
              <Icon aria-hidden />
            </span>
            <div className={s.checkBody}>
              <Text>
                {r.kind === "Judge" || r.kind === "You confirm" ? <span className={s.checkKind}>{r.kind}</span> : null}
                {r.text}
              </Text>
              {r.verdict && (r.state !== "passed" || r.reason) ? (
                <Text size="xs" tone="quiet">
                  <span className={s[r.state]}>{r.kind === "Judge" ? `Judge: ${r.verdict}` : r.verdict}</span>
                  {r.reason ? ` · ${r.reason}` : ""}
                </Text>
              ) : null}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function Prs({ prs }: { prs: readonly PrRef[] }) {
  if (prs.length === 0) return null;
  return (
    <section>
      <Section label="Pull requests" />
      {prs.map((pr) => (
        <div key={pr.changeId} className={s.prRow}>
          <a className={s.prLink} href={pr.url} target="_blank" rel="noreferrer" title={pr.url}>
            #{pr.number}
          </a>
          <StatusChip tone={prTone(pr)}>{prStage(pr)}</StatusChip>
          {pr.position !== undefined ? (
            <Text size="xs" tone="quiet">
              {`position ${pr.position + 1} in the train`}
            </Text>
          ) : null}
          {pr.taskId ? (
            <Text size="xs" tone="quiet">
              {`by ${pr.taskId}`}
            </Text>
          ) : null}
        </div>
      ))}
    </section>
  );
}

export function Fleet(props: {
  lanes: readonly AgentLane[];
  loading: boolean;
  prs: readonly PrRef[];
  checks: readonly CheckSpec[] | undefined;
  claim: Claim | undefined;
  summary: string | undefined;
  onOpenLane: (lane: AgentLane) => void;
}) {
  return (
    <div data-screen="order.fleet">
      <Section label="Fleet" {...(props.summary ? { detail: props.summary } : {})} />
      {props.lanes.length === 0 ? (
        <Text size="xs" tone="quiet">
          {props.loading ? "Loading the order…" : "No agents yet. The lead starts them after it freezes the brief."}
        </Text>
      ) : (
        props.lanes.map((l) => <Lane key={l.laneId} lane={l} onOpen={props.onOpenLane} />)
      )}
      <Prs prs={props.prs} />
      <DoneWhen checks={props.checks} claim={props.claim} />
    </div>
  );
}
