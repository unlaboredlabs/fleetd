// The panel's Activity: what happened in the project while the person was away, newest first. One calm line per event
// (an icon, what happened, the quieter detail, its time) under its day's name, a divider under what came in since
// they last looked, and runs of one thing (a PR reviewed again and again) folded into one row that opens. A line
// that names an agent or a PR opens it in the panel. Older events load as the list nears its end; new ones stream in
// from the data layer's events (hooks.ts), so nothing here polls.
import {
  Ban,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleSlash,
  CircleX,
  Flag,
  Gauge,
  GitMerge,
  GitPullRequestArrow,
  Hand,
  KeyRound,
  ListPlus,
  MessageSquareText,
  Play,
  Scale,
  ShieldCheck,
  Smartphone,
  TriangleAlert,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import { useData } from "../../src/data/react";
import { projectKey } from "../../src/data/store";
import { Button, Dot, EmptyState, Text, Truncate, VirtualList, cx } from "../../ui";
import { shortClock } from "../chat/format";
import { useNow } from "../live/clock";
import { CallError } from "../../src/data/queries";
import { panelRoute, toHash, type ProjectKey } from "../shell/routes";
import { useActivityFeed } from "./hooks";
import { KINDS, KIND_WORD, layout, type ActivityKind, type Icon, type KindFilter, type Line, type Row, type Tone } from "./model";
import { activitySeenOf, markActivitySeen } from "./seen";
import s from "./activity.module.css";

const ICON: Readonly<Record<Icon, LucideIcon>> = {
  started: Play,
  finished: CircleCheck,
  failed: CircleX,
  cancelled: CircleSlash,
  review: MessageSquareText,
  queued: GitPullRequestArrow,
  merged: GitMerge,
  sentBack: Undo2,
  refused: Ban,
  approval: Hand,
  secret: KeyRound,
  answered: ShieldCheck,
  denied: CircleSlash,
  order: ListPlus,
  orderDone: Flag,
  decision: Scale,
  warning: TriangleAlert,
  device: Smartphone,
  cap: Gauge,
};

const TONE: Readonly<Record<Tone, string>> = {
  "needs-you": "var(--warning)",
  failed: "var(--danger)",
  done: "var(--success)",
  quiet: "var(--faint)",
};

const ALL: KindFilter = new Set();

type Item = Row | { readonly t: "end"; readonly key: string };

export function ActivityPane({ project }: { project: ProjectKey }) {
  // A fresh feed per project: its filter, its open runs and the mark it read on opening.
  return <Feed key={projectKey(project)} project={project} />;
}

function Feed({ project }: { project: ProjectKey }) {
  const key = projectKey(project);
  const fresh = useData((st) => st.fresh);
  const [filter, setFilter] = useState<KindFilter>(ALL);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  // What the person had seen before this opened: the divider stays there while they read.
  const [seenAtOpen] = useState(() => activitySeenOf(key));
  const feed = useActivityFeed(project, filter);
  const nowMs = useNow(true, 60_000);
  const newest = feed.lines?.[0]?.seq;
  useEffect(() => {
    if (newest !== undefined) markActivitySeen(key, newest);
  }, [key, newest]);

  const items = useMemo((): readonly Item[] | undefined => {
    if (feed.lines === undefined) return undefined;
    const rows: Item[] = layout(feed.lines, { nowMs, seenSeq: seenAtOpen, open });
    return feed.lines.length === 0 ? rows : [...rows, { t: "end", key: "end" }];
  }, [feed.lines, nowMs, seenAtOpen, open]);

  const toggleKind = (kind: ActivityKind | null) =>
    setFilter((f) => {
      if (kind === null) return ALL;
      const next = new Set(f);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next.size === KINDS.length ? ALL : next;
    });
  const toggleRun = (runKey: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (next.has(runKey)) next.delete(runKey);
      else next.add(runKey);
      return next;
    });

  return (
    <div className={s.pane} data-screen={items === undefined && feed.error === null ? "activity.loading" : "activity"}>
      <div className={s.chips} role="group" aria-label="Show">
        <Button variant={filter.size === 0 ? "secondary" : "quiet"} size="sm" aria-pressed={filter.size === 0} onClick={() => toggleKind(null)}>
          All
        </Button>
        {KINDS.map((k) => (
          <Button key={k} variant={filter.has(k) ? "secondary" : "quiet"} size="sm" aria-pressed={filter.has(k)} onClick={() => toggleKind(k)}>
            {KIND_WORD[k]}
          </Button>
        ))}
      </div>
      {!fresh ? (
        <span className={s.liveness} role="status">
          <Dot color="var(--warning)" />
          <Text size="xs">Not live: reconnecting</Text>
        </span>
      ) : null}
      {feed.error !== null && items === undefined ? (
        <Failed error={feed.error} retry={feed.retry} />
      ) : items === undefined && !fresh ? (
        <div className={s.note}>
          <Text tone="quiet">Activity shows once you’re connected.</Text>
        </div>
      ) : items === undefined ? (
        <Skeleton />
      ) : items.length === 0 ? (
        filter.size === 0 ? (
          <EmptyState title="Nothing has happened yet">
            When agents start and finish, PRs are reviewed and merged, or the lead asks you for something, it shows here.
          </EmptyState>
        ) : (
          <EmptyState
            title="Nothing of this kind"
            actions={
              <Button variant="secondary" size="sm" onClick={() => toggleKind(null)}>
                Show everything
              </Button>
            }
          >
            Nothing like this happened here in the last 30 days.
          </EmptyState>
        )
      ) : (
        <div className={s.list}>
          <VirtualList
            items={items}
            getKey={(item) => item.key}
            renderItem={(item) => <ItemView item={item} project={project} feed={feed} onToggle={toggleRun} />}
            estimateSize={30}
            aria-label="Activity"
          />
        </div>
      )}
    </div>
  );
}

function ItemView({
  item,
  project,
  feed,
  onToggle,
}: {
  item: Item;
  project: ProjectKey;
  feed: ReturnType<typeof useActivityFeed>;
  onToggle: (key: string) => void;
}) {
  switch (item.t) {
    case "day":
      return (
        <div className={s.day} role="heading" aria-level={3}>
          <Text size="xs" tone="quiet" strong>
            {item.label}
          </Text>
        </div>
      );
    case "since":
      return (
        <div className={s.since} role="separator" aria-label="Since you last looked">
          <Text size="xs" tone="accent">
            Since you last looked
          </Text>
        </div>
      );
    case "line":
      return <LineRow line={item.line} project={project} child={item.child === true} />;
    case "run":
      return <RunRow item={item} onToggle={onToggle} />;
    case "end":
      return <End feed={feed} />;
  }
}

/** An icon in its tone. */
function Mark({ icon, tone }: { icon: Icon; tone: Tone }) {
  const Glyph = ICON[icon];
  return (
    <span className={s.icon} style={{ color: TONE[tone] }}>
      <Glyph size={14} strokeWidth={1.75} aria-hidden />
    </span>
  );
}

/** One event: icon, what happened, the detail, its time. A link when it names an agent or a PR. */
const LineRow = memo(function LineRow({ line, project, child }: { line: Line; project: ProjectKey; child: boolean }) {
  const body = (
    <>
      <Mark icon={line.icon} tone={line.tone} />
      <span className={s.text}>
        <Truncate size="sm" expand="none" strong={line.tone === "needs-you"}>
          {line.text}
        </Truncate>
      </span>
      {line.detail === undefined ? <span className={s.fill} /> : (
        <span className={s.detail}>
          <Truncate size="xs" tone="quiet" expand="none">
            {line.detail}
          </Truncate>
        </span>
      )}
      <Text size="xs" tone="faint" tabular>
        {shortClock(line.at)}
      </Text>
    </>
  );
  const className = cx(s.row, child && s.child);
  // Its ids, if a person wants them, are in the tooltip: never in the row's words.
  return line.link === undefined ? (
    <div className={className} title={line.ids} data-event={line.seq}>
      {body}
    </div>
  ) : (
    <a className={cx(className, s.link)} href={toHash(panelRoute(project, line.link))} title={line.ids} data-event={line.seq}>
      {body}
    </a>
  );
});

/** A run folded into one row: the newest line's icon, how many, the newest (an agent by its title), and a chevron that opens it. */
function RunRow({ item, onToggle }: { item: Extract<Row, { t: "run" }>; onToggle: (key: string) => void }) {
  const top = item.lines[0];
  if (top === undefined) return null;
  const Chevron = item.open ? ChevronDown : ChevronRight;
  return (
    <button type="button" className={cx(s.row, s.run)} aria-expanded={item.open} onClick={() => onToggle(item.key)} data-run={item.key}>
      <Mark icon={top.icon} tone={top.tone} />
      <span className={s.text}>
        <Truncate size="sm" expand="none">
          {item.label}
        </Truncate>
      </span>
      <span className={s.detail}>
        <Truncate size="xs" tone="quiet" expand="none">
          {`Latest: ${top.kind === "agents" ? (top.detail ?? top.text) : top.text}`}
        </Truncate>
      </span>
      <Text size="xs" tone="faint" tabular>
        {shortClock(top.at)}
      </Text>
      <Chevron className={s.chevron} size={14} aria-hidden />
    </button>
  );
}

/** The list's foot: loads the next page as it scrolls into view, or says the log ends here. */
function End({ feed }: { feed: ReturnType<typeof useActivityFeed> }) {
  const { hasOlder, loadOlder, loadingOlder, olderFailed, retryOlder } = feed;
  // A page that failed waits for Retry: asking again by itself would ask forever.
  useEffect(() => {
    if (hasOlder && !olderFailed) loadOlder();
  }, [hasOlder, olderFailed, loadOlder]);
  return (
    <div className={s.end}>
      {olderFailed && !loadingOlder ? (
        <Button variant="quiet" size="sm" onClick={retryOlder}>
          Couldn’t load older activity. Retry
        </Button>
      ) : hasOlder || loadingOlder ? (
        <span role="status">
          <Text size="xs" tone="faint">
            Loading older activity…
          </Text>
        </span>
      ) : (
        <Text size="xs" tone="faint">
          That’s everything from the last 30 days.
        </Text>
      )}
    </div>
  );
}

function Failed({ error, retry }: { error: Error; retry: () => void }) {
  // A hub from before events_list answers that it has no such tool.
  const old = error instanceof CallError && error.error.code === "not_found" && error.error.message.startsWith("No tool");
  return (
    <EmptyState
      tone="danger"
      title="Couldn’t read the activity"
      actions={
        old ? null : (
          <Button variant="secondary" size="sm" onClick={retry}>
            Retry
          </Button>
        )
      }
    >
      {old ? "This hub is older than the app: update it to see a project’s activity." : error.message}
    </EmptyState>
  );
}

function Skeleton() {
  return (
    <div className={s.skeleton} role="status" aria-label="Loading the activity">
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}
