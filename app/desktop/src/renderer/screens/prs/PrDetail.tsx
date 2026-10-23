// One PR: its title and where it stands, then Overview (the facts, the description, checks, reviews and their
// findings, its way to main so far) or Changes (the files and their diff). Open on GitHub stays one click away.
import { ExternalLink } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useData, useToolQuery } from "../../src/data/react";
import { selectLiveAgents } from "../../src/data/selectors";
import type { PrCheck, PrGetOutput, PrReviewEntry, PrRow } from "../../../shared/contracts";
import { codeRuns, machineCode } from "../chat/format";
import { Button, InlineCode, Markdown, StatusChip, Tab, TabList, TabPanel, Tabs, Text, Truncate, cx, toast } from "../../ui";
import { AgentRowLink } from "../agents/AgentsPane";
import { DiffPane } from "./DiffPane";
import {
  authorWords,
  checkTook,
  checkWord,
  checksDetail,
  checksWord,
  findingsWord,
  githubLine,
  isOpen,
  movedWords,
  reviewerWords,
  reviewsWord,
  sortChecks,
  stateLine,
  stat,
  verdictWord,
  when,
} from "./words";
import s from "./prs.module.css";

export type PrTab = "overview" | "changes";

export const openExternal = (url: string): void => {
  void window.fleetd.openExternal(url).then((o) => {
    if (!o.ok) toast({ title: "Couldn’t open GitHub", description: o.message, tone: "danger" });
  });
};

/** Passed checks fold away past this many, so the failing ones stay in sight. */
const PASSED_SHOWN = 5;
const HISTORY_SHOWN = 4;

interface PrDetailProps {
  readonly repo: string;
  readonly number: number;
  readonly row: PrRow | undefined;
  readonly nowMs: number | undefined;
  readonly tab: PrTab;
  readonly onTab: (tab: PrTab) => void;
  /** The screen already says GitHub wasn't reached. */
  readonly githubSaid: boolean;
}

export function PrDetail({ repo, number, row, nowMs, tab, onTab, githubSaid }: PrDetailProps) {
  const query = useToolQuery("pr_get", { repo, number });
  const fresh = useData((st) => st.fresh);
  const data = query.data;
  const pr = data?.pr ?? row;

  if (pr === undefined) {
    // Nothing held and no hub to ask: "Loading" would never finish.
    return !fresh ? (
      <div className={s.paneNote} data-screen="prs.detail.offline">
        <Text tone="quiet">#{number} shows once you’re connected.</Text>
      </div>
    ) : query.isError ? (
      <div className={s.paneNote} data-screen="prs.detail.error" role="alert">
        <Text tone="quiet">Couldn’t load #{number}.</Text>
        <Button onClick={() => void query.refetch()}>Retry</Button>
      </div>
    ) : (
      <div className={s.paneNote} data-screen="prs.detail.loading" aria-busy="true">
        <Text tone="quiet">Loading #{number}…</Text>
      </div>
    );
  }

  // The hub's clock from the list's answer; a PR opened before the list answered reads against its own update.
  const now = nowMs ?? Date.parse(pr.updatedAt);
  const state = stateLine(pr);
  const additions = data?.additions;
  const deletions = data?.deletions;
  const files = data?.changedFiles;
  return (
    <Tabs
      className={s.pr}
      value={tab}
      onValueChange={(v) => onTab(v === "changes" ? "changes" : "overview")}
      data-screen={data !== undefined ? "prs.detail" : query.isError ? "prs.detail.error" : "prs.detail.loading"}
    >
      <div className={s.prHead}>
        <div className={s.prTitleRow}>
          <span className={s.prTitle}>
            <Truncate as="h2" size="lg" strong lines={3} expand="inline">
              {pr.title === "" ? `#${pr.number}` : pr.title}
            </Truncate>
          </span>
          <Button variant="secondary" icon={<ExternalLink aria-hidden />} onClick={() => openExternal(pr.url)}>
            Open on GitHub
          </Button>
        </div>
        <div className={s.prMeta}>
          <StatusChip tone={state.tone}>{state.word}</StatusChip>
          <Text size="sm" tone="quiet" tabular>
            #{pr.number} in {pr.repo}
          </Text>
          {pr.branch !== undefined ? (
            <span className={s.branch} data-text="code">
              <Truncate mono size="xs" tone="quiet">
                {data?.baseBranch === undefined ? pr.branch : `${pr.branch} → ${data.baseBranch}`}
              </Truncate>
            </span>
          ) : null}
          {additions !== undefined && deletions !== undefined ? (
            <Text size="sm" tone="quiet" tabular>
              <span className={s.add}>+{stat(additions)}</span> <span className={s.del}>−{stat(deletions)}</span>
            </Text>
          ) : null}
        </div>
        <TabList aria-label="Pull request">
          <Tab value="overview">Overview</Tab>
          <Tab value="changes" count={files === undefined ? undefined : stat(files)}>
            Changes
          </Tab>
        </TabList>
      </div>
      <TabPanel value="overview" className={s.overview}>
        {data === undefined ? (
          !fresh ? (
            <div className={s.paneNote}>
              <Text tone="quiet">The rest of #{number} shows once you’re connected.</Text>
            </div>
          ) : query.isError ? (
            <div className={s.paneNote} role="alert">
              <Text tone="quiet">Couldn’t load the rest of #{number}.</Text>
              <Button onClick={() => void query.refetch()}>Retry</Button>
            </div>
          ) : (
            <div className={s.paneNote} aria-busy="true">
              <Text tone="quiet">Loading…</Text>
            </div>
          )
        ) : (
          <Overview data={data} now={now} githubSaid={githubSaid} />
        )}
      </TabPanel>
      <TabPanel value="changes" className={s.changesPanel}>
        {tab === "changes" ? <DiffPane repo={repo} number={number} additions={additions} deletions={deletions} githubDown={data?.githubError !== undefined} /> : null}
      </TabPanel>
    </Tabs>
  );
}

function Overview({ data, now, githubSaid }: { data: PrGetOutput; now: number; githubSaid: boolean }) {
  const pr = data.pr;
  const state = stateLine(pr);
  const checks = pr.checks === undefined ? undefined : checksWord(pr.checks);
  const reviews = reviewsWord(pr.review);
  const author = authorWords(pr.author);
  return (
    <div className={s.measure}>
      {data.githubError !== undefined && !githubSaid ? (
        <div className={s.notice} role="status">
          <Text size="sm" tone="warning">
            {pr.checks !== undefined ? githubLine([pr]) : "GitHub couldn’t be reached, so the description, checks and files may be missing."}
          </Text>
          <Text size="xs" tone="quiet">
            <WithCode text={data.githubError} />
          </Text>
        </div>
      ) : null}
      <dl className={s.facts}>
        <Fact label="Status">
          <Text size="sm">{state.sentence}</Text>
          {pr.queue?.reason !== undefined && pr.queue.reason !== "" ? (
            <Text size="xs" tone="quiet" preserveLines>
              <WithCode text={pr.queue.reason} />
            </Text>
          ) : null}
        </Fact>
        <Fact label="Checks">
          {checks === undefined ? (
            <Text size="sm" tone="quiet">
              {pr.checks === undefined ? "Not known: GitHub wasn’t reached." : "None ran."}
            </Text>
          ) : (
            <Text size="sm" tone={checks.tone === "failed" ? "danger" : "default"}>
              {checks.text}
            </Text>
          )}
        </Fact>
        <Fact label="Reviews">
          <Text size="sm" tone={reviews?.tone === "failed" ? "danger" : reviews === undefined ? "quiet" : "default"}>
            {reviews?.text ?? "None asked for."}
          </Text>
        </Fact>
        <Fact label="Written by">
          <Text size="sm" tone={author === undefined ? "quiet" : "default"}>
            {author ?? "Not known."}
          </Text>
          {pr.author.title !== undefined && pr.author.title !== "" ? (
            <Text size="xs" tone="quiet">
              Asked to: {pr.author.title}
            </Text>
          ) : null}
        </Fact>
        <Fact label="Opened">
          <Text size="sm" tabular>
            {when(pr.createdAt, now)}
            {pr.mergedAt !== undefined ? ` · merged ${when(pr.mergedAt, now)}` : ` · updated ${when(pr.updatedAt, now)}`}
          </Text>
        </Fact>
      </dl>

      {isOpen(pr) ? <AtWork repo={pr.repo} number={pr.number} /> : null}

      <Section title="Description">
        {data.body.trim() === "" ? (
          <Text size="sm" tone="quiet">
            No description.
          </Text>
        ) : (
          <Markdown source={machineCode(data.body)} />
        )}
      </Section>

      <Section title="Checks" aside={pr.checks === undefined ? undefined : checksDetail(pr.checks)}>
        {data.checks.length === 0 && pr.checks === undefined ? (
          <Text size="sm" tone="quiet">
            Not known: GitHub wasn’t reached.
          </Text>
        ) : (
          <Checks checks={data.checks} />
        )}
      </Section>

      <Section title="Reviews">
        {data.reviews.length === 0 ? (
          <Text size="sm" tone="quiet">
            No reviews yet.
          </Text>
        ) : (
          <ol className={s.reviews}>
            {data.reviews.map((r, i) => (
              <Review key={`${r.at}\u0000${i}`} review={r} now={now} />
            ))}
          </ol>
        )}
      </Section>

      {data.history.length > 0 ? (
        <Section title="On its way to main">
          <History steps={data.history} now={now} />
        </Section>
      ) : null}
    </div>
  );
}

const ALL_AGENTS = {} as const;

/** The agents working on this PR now (its reviewers, a fixer), as the panel's agents list them; each opens its work. */
function AtWork({ repo, number }: { repo: string; number: number }) {
  useToolQuery("agents_list", ALL_AGENTS);
  const agents = useData(selectLiveAgents);
  const on = useMemo(() => agents?.filter((a) => a.row.pr?.repo === repo && a.row.pr.number === number) ?? [], [agents, repo, number]);
  if (on.length === 0) return null;
  return (
    <Section title="At work on it now">
      <div className={s.atWork}>
        {on.map((a) => (
          <AgentRowLink key={a.id} agent={a} />
        ))}
      </div>
    </Section>
  );
}

/** The hub's words, with ids, keys and `code` set as code. */
export function WithCode({ text }: { text: string }) {
  return (
    <>
      {codeRuns(machineCode(text)).map((run, i) => (run.code ? <InlineCode key={i}>{run.text}</InlineCode> : run.text))}
    </>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={s.fact}>
      <dt>
        <Text size="sm" tone="quiet">
          {label}
        </Text>
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

function Section({ title, aside, children }: { title: string; aside?: string | undefined; children: ReactNode }) {
  return (
    <section className={s.section} aria-label={title}>
      <div className={s.sectionHead}>
        <Text as="h3" size="md" strong>
          {title}
        </Text>
        {aside !== undefined && aside !== "" ? (
          <Text size="xs" tone="quiet" tabular>
            {aside}
          </Text>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Checks({ checks }: { checks: readonly PrCheck[] }) {
  const [all, setAll] = useState(false);
  if (checks.length === 0) {
    return (
      <Text size="sm" tone="quiet">
        No checks on this version.
      </Text>
    );
  }
  const sorted = sortChecks(checks);
  const firstPassed = sorted.findIndex((c) => c.state !== "failing" && c.state !== "pending");
  const cut = firstPassed === -1 ? sorted.length : firstPassed + PASSED_SHOWN;
  const shown = all ? sorted : sorted.slice(0, cut);
  return (
    <>
      <ul className={s.checks}>
        {shown.map((c, i) => {
          const word = checkWord(c);
          const took = checkTook(c);
          return (
            <li key={`${c.name}\u0000${i}`} className={s.check}>
              <span className={s.checkWord}>
                <StatusChip tone={word.tone}>{word.text}</StatusChip>
              </span>
              <span className={s.checkName} data-text="code">
                <Truncate size="sm">{c.name}</Truncate>
              </span>
              {took !== undefined ? (
                <Text size="xs" tone="quiet" tabular>
                  {took}
                </Text>
              ) : null}
              {c.url !== undefined ? (
                <Button variant="quiet" iconOnly aria-label={`Open ${c.name} on GitHub`} onClick={() => openExternal(c.url ?? "")}>
                  <ExternalLink aria-hidden />
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {sorted.length > shown.length ? (
        <div className={s.moreRow}>
          <Button variant="quiet" onClick={() => setAll(true)}>
            {`Show ${sorted.length - shown.length} more`}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function Review({ review, now }: { review: PrReviewEntry; now: number }) {
  const verdict = verdictWord(review);
  const findings = findingsWord(review);
  return (
    <li className={cx(s.review, !review.current && s.outdated)}>
      <div className={s.reviewHead}>
        <Text size="sm" strong>
          {reviewerWords(review)}
        </Text>
        <StatusChip tone={verdict.tone}>{verdict.text}</StatusChip>
        {findings !== "" ? (
          <Text size="xs" tone={(review.blocking ?? 0) > 0 ? "danger" : "quiet"}>
            {findings}
          </Text>
        ) : null}
        <span className={s.reviewWhen}>
          <Text size="xs" tone="quiet" tabular>
            {review.current ? when(review.at, now) : `${when(review.at, now)} · an earlier version`}
          </Text>
        </span>
      </div>
      {review.text.trim() !== "" ? <Markdown source={machineCode(review.text)} /> : null}
    </li>
  );
}

function History({ steps, now }: { steps: PrGetOutput["history"]; now: number }) {
  const [all, setAll] = useState(false);
  const known = steps.flatMap((step) => {
    const words = movedWords(step.to);
    return words === undefined ? [] : [{ at: step.at, words }];
  });
  const shown = all ? known : known.slice(0, HISTORY_SHOWN);
  return (
    <>
      <ol className={s.history}>
        {shown.map((step, i) => (
          <li key={`${step.at}\u0000${i}`}>
            <span className={s.historyWhen}>
              <Text size="xs" tone="quiet" tabular>
                {when(step.at, now)}
              </Text>
            </span>
            <Text size="sm">{step.words}</Text>
          </li>
        ))}
      </ol>
      {known.length > shown.length ? (
        <div className={s.moreRow}>
          <Button variant="quiet" onClick={() => setAll(true)}>
            {`Show ${known.length - shown.length} earlier`}
          </Button>
        </div>
      ) : null}
    </>
  );
}
