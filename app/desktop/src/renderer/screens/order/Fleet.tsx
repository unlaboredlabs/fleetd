// The order's left pane: its agents (each opens its steer box), its PRs, and what "done" means for it.

import { CheckCircle2, ChevronDown, ChevronRight, Circle, CircleAlert, CircleX } from "lucide-react";
import { useState } from "react";
import { cx, RoleTag, StatusChip, Text, Truncate, type StatusTone } from "../../ui";
import type { AgentLane, CheckSpec, Claim, LaneStatus, PrRef } from "../../../shared/contracts";
import { fmtElapsed, fmtTokens, parseMs } from "../board/format";
import { ActivityBars } from "../board/parts";
import { shortModel } from "./format";
import { doneRows, doneSummary, type CheckState } from "./doneWhen";
import { InlineText } from "./Conversation";
import { activityLine, prStage, prTone } from "./lanes";
import s from "./order.module.css";


export function ActivityText({ lane }: { lane: AgentLane }) {
  const line = activityLine(lane);
  const tone = line.tone === "loud" ? s.loud : line.tone === "danger" ? s.danger : "";
  return (
    <>
      <span className={cx(s.activityWords, tone)}>
        <Truncate size="xs" tone="inherit" expand="none">
          {line.words}
        </Truncate>
      </span>
      {line.machine ? (
        <Truncate as="code" size="sm" mono tone="quiet" expand="none">
          {line.machine}
        </Truncate>
      ) : null}
    </>
  );
}

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

const working = (l: AgentLane) => l.status === "working" || l.status === "starting";

/**
 * One agent (GPUI live/lanes.rs): role, task id, title and model; what it is doing now, how long it has run, its
 * activity bars and tokens; then its PR, branch and "What it was told". The row opens its steer box.
 */
function Lane({ lane, now, onOpen, onTold }: { lane: AgentLane; now: number; onOpen: (lane: AgentLane) => void; onTold: (lane: AgentLane) => void }) {
  const id = lane.taskId ?? "";
  const meta = [lane.model ? shortModel(lane.model) : undefined, lane.effort].filter(Boolean).join(" · ");
  const started = lane.status === "queued" ? undefined : parseMs(lane.startedAt);
  const ended = parseMs(lane.endedAt);
  const clock = started === undefined ? "" : fmtElapsed((ended ?? now) - started);
  const tokens = lane.live?.tokens;
  const running = working(lane) || lane.status === "waiting";
  return (
    <div className={s.laneBlock}>
      <button type="button" className={s.lane} onClick={() => onOpen(lane)} aria-label={`Steer ${id || lane.title}`} data-lane={lane.laneId}>
        <RoleTag role={lane.role} width={88} />
        <span className={s.laneHead}>
          {id ? (
            <span className={s.laneId}>
              <Truncate size="sm" mono tone="quiet" expand="none">
                {id}
              </Truncate>
            </span>
          ) : null}
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
          <span className={s.laneDoing}>
            <ActivityText lane={lane} />
          </span>
          <span className={s.laneNumbers}>
            <span className={s.laneClock}>{clock}</span>
            {running ? <ActivityBars spark={lane.live?.spark} startedMs={started} role={lane.role} now={now} /> : null}
            <span className={s.laneTokens}>{tokens ? fmtTokens(tokens.input + tokens.output) : ""}</span>
          </span>
        </span>
      </button>
      {lane.pr || lane.branch || lane.threadRef ? (
        <div className={s.laneExtras}>
          {lane.pr ? (
            <span className={s.flexNone}>
              <a className={s.prLink} href={lane.pr.url} target="_blank" rel="noreferrer" title={lane.pr.url}>
                #{lane.pr.number}
              </a>{" "}
              <StatusChip tone={prTone(lane.pr)}>{prStage(lane.pr)}</StatusChip>
            </span>
          ) : null}
          {lane.branch ? (
            <span className={s.laneBranch}>
              <Truncate as="code" size="sm" mono tone="quiet">
                {lane.branch}
              </Truncate>
            </span>
          ) : null}
          {lane.threadRef ? (
            <button type="button" className={cx(s.linkButton, s.flexNone)} onClick={() => onTold(lane)}>
              {`What ${id || "it"} was told`}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
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
              <div>
                {r.kind === "Judge" || r.kind === "You confirm" ? <span className={s.checkKind}>{r.kind}</span> : null}
                <InlineText text={r.text} />
              </div>
              {r.verdict && (r.state !== "passed" || r.reason) ? (
                <div className={s.checkVerdict}>
                  <span className={s[r.state]}>{r.verdict}</span>
                  {r.reason ? <InlineText size="xs" tone="quiet" text={r.reason} /> : null}
                </div>
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

const folded = (l: AgentLane) => l.status === "done" || l.status === "cancelled";

export function Fleet(props: {
  lanes: readonly AgentLane[];
  now: number;
  onTold: (lane: AgentLane) => void;
  loading: boolean;
  prs: readonly PrRef[];
  checks: readonly CheckSpec[] | undefined;
  claim: Claim | undefined;
  summary: string | undefined;
  onOpenLane: (lane: AgentLane) => void;
}) {
  const [doneOpen, setDoneOpen] = useState(false);
  const active = props.lanes.filter((l) => !folded(l));
  const done = props.lanes.filter(folded);
  const lane = (l: AgentLane) => <Lane key={l.laneId} lane={l} now={props.now} onOpen={props.onOpenLane} onTold={props.onTold} />;
  const Chevron = doneOpen ? ChevronDown : ChevronRight;
  return (
    <div data-screen="order.fleet">
      <Section label="Fleet" {...(props.summary ? { detail: props.summary } : {})} />
      {props.lanes.length === 0 ? (
        <Text size="xs" tone="quiet">
          {props.loading ? "Loading the order…" : "No agents yet. The lead starts them after it freezes the brief."}
        </Text>
      ) : (
        <>
          {active.map(lane)}
          {done.length > 0 ? (
            <div className={s.doneFold}>
              <button type="button" className={s.disclosure} aria-expanded={doneOpen} onClick={() => setDoneOpen((o) => !o)}>
                <Chevron className={s.chevron} aria-hidden />
                <Text size="xs" tone="inherit">{`Done (${String(done.length)})`}</Text>
              </button>
              {doneOpen ? done.map(lane) : null}
            </div>
          ) : null}
        </>
      )}
      <Prs prs={props.prs} />
      <DoneWhen checks={props.checks} claim={props.claim} />
    </div>
  );
}
