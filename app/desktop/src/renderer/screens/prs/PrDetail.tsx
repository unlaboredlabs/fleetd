// One PR: its title and where it stands, then Overview (the facts, the description, checks, reviews and their
// findings, its way to main so far) or Changes (the files and their diff). Open on GitHub stays one click away.
import { ExternalLink } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useToolQuery } from "../../src/data/react";
import type { PrCheck, PrGetOutput, PrReviewEntry, PrRow } from "../../src/data/pr-contract";
import { Button, Markdown, StatusChip, Tab, TabList, TabPanel, Tabs, Text, Truncate, cx, toast } from "../../ui";
import { DiffPane } from "./DiffPane";
import {
  authorWords,
  capital,
  checkTook,
  checkWord,
  checksDetail,
  checksWord,
  findingsWord,
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

type TabId = "overview" | "changes";
// The tab is the reader's, kept while the app runs: reading diffs one PR after another stays on Changes.
let lastTab: TabId = "overview";

export const openExternal = (url: string): void => {
  void window.fleetd.openExternal(url).then((o) => {
    if (!o.ok) toast({ title: "Couldn’t open GitHub", description: o.message, tone: "danger" });
  });
};

/** Passed checks fold away past this many, so the failing ones stay in sight. */
const PASSED_SHOWN = 5;
const HISTORY_SHOWN = 4;

export function PrDetail({ repo, number, row, nowMs }: { repo: string; number: number; row: PrRow | undefined; nowMs: number | undefined }) {
  const query = useToolQuery("pr_get", { repo, number });
  const [tab, setTab] = useState<TabId>(lastTab);
  const data = query.data;
  const pr = data?.pr ?? row;

  if (pr === undefined) {
    return query.isError ? (
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
      onValueChange={(v) => {
        const next = v === "changes" ? "changes" : "overview";
        lastTab = next;
        setTab(next);
      }}
      data-screen={data === undefined ? "prs.detail.loading" : "prs.detail"}
    >
      <div className={s.prHead}>
        <div className={s.prTitleRow}>
          <span className={s.prTitle}>
            <Text as="h2" size="lg" strong>
              {pr.title === "" ? `#${pr.number}` : pr.title}
            </Text>
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
            <span className={s.branch}>
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
          query.isError ? (
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
          <Overview data={data} now={now} />
        )}
      </TabPanel>
      <TabPanel value="changes" className={s.changesPanel}>
        {tab === "changes" ? <DiffPane repo={repo} number={number} additions={additions} deletions={deletions} /> : null}
      </TabPanel>
    </Tabs>
  );
}

function Overview({ data, now }: { data: PrGetOutput; now: number }) {
  const pr = data.pr;
  const state = stateLine(pr);
  const checks = pr.checks === undefined ? undefined : checksWord(pr.checks);
  const reviews = reviewsWord(pr.review);
  const author = authorWords(pr.author);
  return (
    <div className={s.measure}>
      {data.githubError !== undefined ? (
        <div className={s.banner} role="status">
          <Text size="sm" tone="warning">
            GitHub couldn’t be reached, so the description, checks and files may be missing.
          </Text>
          <Text size="xs" tone="quiet">
            {data.githubError}
          </Text>
        </div>
      ) : null}
      <dl className={s.facts}>
        <Fact label="Status">
          <Text size="sm">{state.sentence}</Text>
          {pr.queue?.reason !== undefined && pr.queue.reason !== "" ? (
            <Text size="xs" tone="quiet" preserveLines>
              {pr.queue.reason}
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
            {author === undefined ? "Not known." : capital(author)}
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

      <Section title="Description">
        {data.body.trim() === "" ? (
          <Text size="sm" tone="quiet">
            No description.
          </Text>
        ) : (
          <Markdown source={data.body} />
        )}
      </Section>

      <Section title="Checks" aside={pr.checks === undefined ? undefined : checksDetail(pr.checks)}>
        <Checks checks={data.checks} />
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
              <span className={s.checkName}>
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
        <Button variant="quiet" onClick={() => setAll(true)}>
          {`Show ${sorted.length - shown.length} more`}
        </Button>
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
          {capital(reviewerWords(review))}
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
      {review.text.trim() !== "" ? <Markdown source={review.text} /> : null}
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
        <Button variant="quiet" onClick={() => setAll(true)}>
          {`Show ${known.length - shown.length} earlier`}
        </Button>
      ) : null}
    </>
  );
}
