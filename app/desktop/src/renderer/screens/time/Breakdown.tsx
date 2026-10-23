// The breakdown: agent time per category with what is inside each, the critical path by category on an order, the
// slowest and repeated commands, the CI checks and the time spent waiting on you. With compare on, each category
// shows the period before beside this one. Every row opens the spans behind it.
import type { ReactNode } from "react";
import { PROFILE_WORD, Text, Truncate, cx, humanizeKey } from "../../ui";
import { fmtTokens } from "../live/format";
import type { Linked } from "./data";
import { CAT_LABEL, KIND_WORD, SHOWN, agentName, delta, fmtBytes, fmtDur, gapText, pct, type Missing, type Names, categoryKinds } from "./format";
import type { Category, CategoryTotal, TimeBreakdownOutput } from "./types";
import s from "./Time.module.css";

export interface BreakdownProps {
  readonly data: TimeBreakdownOutput;
  readonly order: boolean;
  readonly missing: Missing | undefined;
  /** Span ids per category on the critical path, when the order's spans are loaded. */
  readonly pathIds: ReadonlyMap<Category, readonly number[]> | undefined;
  readonly onLinked: (linked: Linked, ids?: readonly number[]) => void;
  /** Who ran a repeated command: the agent by what it worked on. */
  readonly names: Names;
}

/** Who ran it, by what it worked on; undefined when this app hasn't seen that agent (another piece of work). */
const agentOf = (names: Names, threadId: string): string | undefined => {
  if (names.leads.has(threadId)) return "lead";
  const lane = names.threads.get(threadId);
  return lane === undefined ? undefined : agentName(lane);
};

/** "Bash 49m (67) · Read 49s (77)": the biggest kinds in a category; first token carries its ≈. */
export const kindsText = (c: CategoryTotal): string =>
  c.kinds
    .filter((k) => k.ms > 0)
    .slice()
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 4)
    .map((k) => `${KIND_WORD[k.kind]} ${k.kind === "model.first_token" ? "≈ " : ""}${fmtDur(k.ms)}${c.cat === "tools" ? ` (${k.n})` : ""}`)
    .join(" · ");

const categoryLink = (cat: Category): Linked => ({ title: `${CAT_LABEL[cat]} time`, kinds: categoryKinds(cat) });

export function Swatch({ cat }: { cat: Category | "failed" }) {
  return <span className={cx(s.swatch, s[`sw_${cat}`])} aria-hidden />;
}

function Section({ title, detail, children }: { title: string; detail: string; children: ReactNode }) {
  return (
    <section className={cx(s.section)}>
      <div className={cx(s.sectionHead)}>
        <Text as="h3" strong>
          {title}
        </Text>
        <Text size="xs" tone="quiet">
          {detail}
        </Text>
      </div>
      {children}
    </section>
  );
}

/** A table row that opens the spans behind it. Cells wrap or truncate; the row grows to its tallest cell. */
function RowButton({ onClick, label, children, className }: { onClick: () => void; label: string; children: ReactNode; className?: string | undefined }) {
  return (
    <button type="button" className={cx(s.tableRow, className)} onClick={onClick} aria-label={label}>
      {children}
    </button>
  );
}

const Num = ({ children, tone }: { children: string; tone?: "quiet" | "danger" | "default" }) => (
  <Text size="sm" mono tabular tone={tone ?? "default"} className={cx(s.num)}>
    {children}
  </Text>
);

export function Breakdown({ data: b, order, missing, pathIds, onLinked, names }: BreakdownProps) {
  const agent = b.agentMs;
  if (agent === 0) {
    return (
      <div className={cx(s.scroll)} data-screen="time.breakdown.empty">
        <Summary b={b} order={order} />
        <div className={cx(s.empty)}>
          <Text strong>No agent time in this period</Text>
          <Text tone="quiet">Nothing ran here in the range picked. Try a longer range or another project.</Text>
        </div>
      </div>
    );
  }
  const prev = b.compare;
  const cats = b.byCategory.filter((c) => SHOWN.includes(c.cat) && c.ms > 0).sort((x, y) => y.ms - x.ms);
  const max = Math.max(1, cats[0]?.ms ?? 1);
  const path = order ? b.criticalPath : undefined;
  const pathTotal = path === undefined ? 0 : path.endMs - path.startMs;
  return (
    <div className={cx(s.scroll)} data-screen="time.breakdown">
      <Summary b={b} order={order} />
      <div className={cx(s.table, prev !== undefined ? s.catsCompare : s.cats)} role="table" aria-label="Agent time by category">
        <div className={cx(s.tableHead)} role="row">
          <Text size="xs" tone="quiet">
            Agent time
          </Text>
          <span />
          <span />
          <span />
          <Text size="xs" tone="quiet">
            inside
          </Text>
          {prev !== undefined ? (
            <>
              <Text size="xs" tone="quiet" className={cx(s.num)}>
                before
              </Text>
              <Text size="xs" tone="quiet" className={cx(s.num)}>
                change
              </Text>
            </>
          ) : null}
        </div>
        {cats.map((c) => {
          const before = prev?.byCategory.find((x) => x.cat === c.cat)?.ms ?? 0;
          return (
            <RowButton
              key={c.cat}
              onClick={() => onLinked(categoryLink(c.cat))}
              label={`${CAT_LABEL[c.cat]}: ${fmtDur(c.ms)}, ${pct(c.ms, agent)} of agent time. Show these spans.`}
            >
              <span className={cx(s.catCell)}>
                <Swatch cat={c.cat} />
                <Truncate expand="none">{CAT_LABEL[c.cat]}</Truncate>
              </span>
              <Num>{fmtDur(c.ms)}</Num>
              <Num tone="quiet">{pct(c.ms, agent)}</Num>
              <span className={cx(s.meter)} aria-hidden>
                <span style={{ width: `${Math.max(2, (c.ms / max) * 100)}%` }} />
              </span>
              <Text size="xs" tone="quiet">
                {kindsText(c)}
              </Text>
              {prev !== undefined ? (
                <>
                  <Num tone="quiet">{fmtDur(before)}</Num>
                  <Num tone="quiet">{delta(before, c.ms)}</Num>
                </>
              ) : null}
            </RowButton>
          );
        })}
      </div>
      {prev !== undefined ? (
        <Text as="p" size="xs" tone="quiet" className={cx(s.after)}>
          Before: {prev.since.slice(0, 10)} to {prev.until.slice(0, 10)} · agent time {fmtDur(prev.agentMs)} → {fmtDur(agent)} ({delta(prev.agentMs, agent)})
        </Text>
      ) : null}

      {b.byProfile !== undefined && b.byProfile.length > 0 ? <ByProfile b={b} /> : null}

      {path !== undefined ? (
        <Section
          title="Critical path"
          detail={`${fmtDur(pathTotal)} end to end; ${fmtDur(path.offPathMs)} of agent time ran off it${path.nothingRunningMs > 0 ? `; ${fmtDur(path.nothingRunningMs)} with nothing running (missing data)` : ""}`}
        >
          <div className={cx(s.table, s.pathTable)} role="table" aria-label="Critical path by category">
            {path.totals
              .filter((c) => c.ms > 0)
              .slice()
              .sort((x, y) => y.ms - x.ms)
              .map((c) => (
                <RowButton
                  key={c.cat}
                  onClick={() => onLinked({ title: `${CAT_LABEL[c.cat]} on the critical path` }, pathIds?.get(c.cat) ?? [])}
                  label={`${CAT_LABEL[c.cat]} on the critical path: ${fmtDur(c.ms)}. Light these spans.`}
                >
                  <span className={cx(s.catCell)}>
                    <Swatch cat={c.cat} />
                    <Truncate expand="none">{CAT_LABEL[c.cat]}</Truncate>
                  </span>
                  <Num>{fmtDur(c.ms)}</Num>
                  <Num tone="quiet">{pct(c.ms, pathTotal)}</Num>
                  <Text size="xs" tone="quiet">
                    {c.kinds === undefined ? "" : c.kinds.slice().sort((x, y) => y.ms - x.ms).slice(0, 4).map((k) => `${KIND_WORD[k.kind]} ${fmtDur(k.ms)}`).join(" · ")}
                  </Text>
                </RowButton>
              ))}
          </div>
        </Section>
      ) : null}

      {b.topCommands.length > 0 ? (
        <Section title="Slowest commands" detail="per call: each call's own time, so calls that ran together can overlap">
          <div className={cx(s.table, s.cmdTable)} role="table" aria-label="Slowest commands">
            <div className={cx(s.tableHead)} role="row">
              {["Command", "runs", "total", "median", "longest", "failed"].map((h, i) => (
                <Text key={h} size="xs" tone="quiet" className={cx(i > 0 && s.num)}>
                  {h}
                </Text>
              ))}
            </div>
            {b.topCommands.map((c) => (
              <RowButton
                key={c.label}
                onClick={() => onLinked({ title: c.label, rule: "slow_commands", label: c.label })}
                label={`${c.label}: ${c.n} runs, ${fmtDur(c.totalMs)}. Show these spans.`}
              >
                <Truncate expand="none" mono size="sm">
                  {c.label}
                </Truncate>
                <Num>{String(c.n)}</Num>
                <Num>{fmtDur(c.totalMs)}</Num>
                <Num>{fmtDur(c.p50Ms)}</Num>
                <Num>{fmtDur(c.maxMs)}</Num>
                <Num tone={c.failed > 0 ? "danger" : "quiet"}>{String(c.failed)}</Num>
              </RowButton>
            ))}
          </div>
        </Section>
      ) : null}

      {b.repeated.length > 0 ? (
        <Repeated b={b} names={names} onLinked={onLinked} />
      ) : null}

      {b.ciChecks.length > 0 ? (
        <Section title="Longest CI checks" detail={`GitHub's own start and end for each run, ±1 s; "on path" is what a check added past the second-slowest`}>
          <div className={cx(s.table, s.cmdTable)} role="table" aria-label="CI checks">
            <div className={cx(s.tableHead)} role="row">
              {["Check", "runs", "total", "median", "longest", "on path"].map((h, i) => (
                <Text key={h} size="xs" tone="quiet" className={cx(i > 0 && s.num)}>
                  {h}
                </Text>
              ))}
            </div>
            {b.ciChecks.map((c) => (
              <RowButton
                key={c.name}
                onClick={() => onLinked({ title: `CI check ${c.name}`, kinds: ["ci.check"], check: c.name })}
                label={`CI check ${c.name}: ${c.n} runs, ${fmtDur(c.totalMs)}. Show these spans.`}
              >
                <Truncate expand="none" mono size="sm">
                  {c.name}
                </Truncate>
                <Num>{String(c.n)}</Num>
                <Num>{fmtDur(c.totalMs)}</Num>
                <Num>{fmtDur(c.p50Ms)}</Num>
                <Num>{fmtDur(c.maxMs)}</Num>
                <Num tone={c.criticalExcessMs > 0 ? "default" : "quiet"}>{c.criticalExcessMs > 0 ? `+${fmtDur(c.criticalExcessMs)}` : "–"}</Num>
              </RowButton>
            ))}
          </div>
        </Section>
      ) : null}

      {b.humanWait.n > 0 ? (
        <Section title="Waiting on you" detail="blocking asks and approvals, from publish to your answer">
          <RowButton
            className={cx(s.humanRow)}
            onClick={() => onLinked({ title: "Time waiting on you", kinds: categoryKinds("human") })}
            label="Show the waits on you"
          >
            <Swatch cat="human" />
            <Text>
              {fmtDur(b.humanWait.totalMs)} over {b.humanWait.n} wait{b.humanWait.n === 1 ? "" : "s"}
              {b.humanWait.longest !== undefined ? (
                <>
                  ; longest {b.humanWait.longest.label !== undefined ? `${humanizeKey(b.humanWait.longest.label)}, ` : ""}
                  {fmtDur(b.humanWait.longest.ms)}
                </>
              ) : null}
            </Text>
          </RowButton>
        </Section>
      ) : null}

      <Notes b={b} missing={missing} />
    </div>
  );
}

/** Commands run again with nothing edited between; the agent column only when this app knows one of their agents. */
/** Agent time and usage on each task profile: what medium saved shows beside what ran high. */
function ByProfile({ b }: { b: TimeBreakdownOutput }) {
  const rows = b.byProfile ?? [];
  const total = rows.reduce((n, r) => n + r.agentMs, 0);
  return (
    <Section title="By task profile" detail="Agent time and output tokens on each; the lead and every review run high">
      <div className={cx(s.table, s.profileTable)} role="table" aria-label="Agent time by task profile">
        <div className={cx(s.tableHead)} role="row">
          {["Profile", "agent time", "share", "model time", "output tokens"].map((h, i) => (
            <Text key={h} size="xs" tone="quiet" className={cx(i > 0 && s.num)}>
              {h}
            </Text>
          ))}
        </div>
        {rows.map((r) => (
          <div key={r.profile} className={cx(s.tableHead, s.profileRow)} role="row">
            <Text size="sm">{PROFILE_WORD[r.profile]}</Text>
            <Num>{fmtDur(r.agentMs)}</Num>
            <Num tone="quiet">{pct(r.agentMs, total)}</Num>
            <Num>{fmtDur(r.modelMs)}</Num>
            <Num>{fmtTokens(r.outputTokens)}</Num>
          </div>
        ))}
      </div>
    </Section>
  );
}

function Repeated({ b, names, onLinked }: { b: TimeBreakdownOutput; names: Names; onLinked: BreakdownProps["onLinked"] }) {
  const byAgent = b.repeated.some((r) => agentOf(names, r.threadId) !== undefined);
  return (
    <Section title="Repeated commands" detail="the same command in one session with nothing edited between runs">
      <div className={cx(s.table, byAgent ? s.repTable : s.repTableNoAgent)} role="table" aria-label="Repeated commands">
        <div className={cx(s.tableHead)} role="row">
          {["Ran again with no edit between", ...(byAgent ? ["agent"] : []), "runs", "total"].map((h, i) => (
            <Text key={h} size="xs" tone="quiet" className={cx(i > 0 && s.num)}>
              {h}
            </Text>
          ))}
        </div>
        {b.repeated.map((r, i) => (
          <RowButton
            key={`${r.label}-${i}`}
            onClick={() => onLinked({ title: `${r.label} repeated with no edit`, rule: "repeat_no_change", label: r.label })}
            label={`${r.label}: ${r.n} runs in a row. Show these spans.`}
          >
            <Truncate expand="none" mono size="sm">
              {r.label}
            </Truncate>
            {byAgent ? (
              <Truncate expand="none" size="xs" tone="quiet" className={cx(s.num)}>
                {agentOf(names, r.threadId) ?? "–"}
              </Truncate>
            ) : null}
            <Num>{`${r.n}×`}</Num>
            <Num>{fmtDur(r.totalMs)}</Num>
          </RowButton>
        ))}
      </div>
    </Section>
  );
}

function Summary({ b, order }: { b: TimeBreakdownOutput; order: boolean }) {
  const n = b.coverage.gaps.length;
  return (
    <div className={cx(s.summary)}>
      <div className={cx(s.summaryLine)}>
        <Text tabular>
          {order ? "wall" : "wall of all work"} {fmtDur(b.wallMs)} · agent time {fmtDur(b.agentMs)}
          {b.wallMs > 0 ? ` · parallelism ${(b.agentMs / b.wallMs).toFixed(1)}×` : ""}
        </Text>
        <Text tone={n === 0 ? "quiet" : "warning"}>{n === 0 ? "no gaps in the data" : `coverage: ${n} gap${n === 1 ? "" : "s"}`}</Text>
      </div>
      <Text as="p" size="xs" tone="quiet">
        Agent time is each lane&apos;s own time added up, so parallel agents count twice; wall time is the clock from start to end.
      </Text>
    </div>
  );
}

/** What these numbers can't say (spec §2f) in the reader's words, and any data the hub knows is missing. */
function Notes({ b, missing }: { b: TimeBreakdownOutput; missing: Missing | undefined }) {
  const lines: string[] = b.coverage.gaps.map((g) => `Missing: ${gapText(g)}.`);
  if (missing?.detailSince !== undefined) {
    lines.push(`Detail since ${missing.detailSince}: commands, CI checks and findings start there (retention); totals before that come from daily roll-ups.`);
  }
  if (b.coverage.capped === true) lines.push("Capped: the hub read only the newest spans.");
  lines.push(
    "≈ First token includes claude's own work before the request, the network, API queueing and prefill; they can't be told apart. Thinking and output are split as streamed; each message's total is exact.",
    "≤ When several tools ran from one message, each call's own time is an upper bound; the group's time is exact.",
    "split: a lead turn serves all the work it woke for, so its time is split equally across it. That is a rule, not a measurement.",
    "±1 s: CI checks use GitHub's start and end, in whole seconds. Lanes on different machines line up to within the link's latency.",
    "Waiting on you runs from when an ask was published to your answer; when you first saw it isn't known.",
  );
  return (
    <section className={cx(s.notes)} aria-label="What isn't exact">
      <Text as="h3" strong>
        What isn&apos;t exact
      </Text>
      {lines.map((l) => (
        <Text key={l} as="p" size="xs" tone={l.startsWith("Missing") || l.startsWith("Capped") || l.startsWith("Detail") ? "warning" : "quiet"}>
          {l}
        </Text>
      ))}
      <Text as="p" size="xs" tone="quiet">
        Spans are kept {b.retentionDays} days; they take {fmtBytes(b.storedBytes)} on the hub.
      </Text>
    </section>
  );
}
