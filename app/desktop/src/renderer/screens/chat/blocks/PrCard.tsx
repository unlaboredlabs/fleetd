// A PR card: its live state from the hub (pr_get, the PR view's own read, refetched on its events), so it reads the
// same as the PR list: where it is on its way to main, its checks, its review, its size. Open shows it in the panel
// beside the chat; merging is fleetd's, never a button here.
import { GitPullRequest } from "lucide-react";
import type { PrBlock } from "../../../../shared/contracts";
import { useToolQuery } from "../../../src/data/react";
import { Button, Text, Truncate } from "../../../ui";
import { openExternal } from "../../prs/PrDetail";
import { checksWord, reviewsShort, stat, stateLine } from "../../prs/words";
import { navigate } from "../../shell/navigation";
import { panelRoute } from "../../shell/routes";
import { useBubbleActions } from "../actions";
import b from "./blocks.module.css";

export function PrCard({ pr, changes = false }: { pr: PrBlock; changes?: boolean }) {
  const actions = useBubbleActions();
  const got = useToolQuery("pr_get", { repo: pr.repo, number: pr.number });
  const row = got.data?.pr;
  const state = row === undefined ? undefined : stateLine(row);
  const checks = row?.checks === undefined ? undefined : checksWord(row.checks);
  const review = row === undefined ? undefined : reviewsShort(row);
  const title = row?.title ?? pr.title ?? `Pull request ${String(pr.number)}`;
  const size = got.data?.additions !== undefined && got.data.deletions !== undefined ? got.data : undefined;
  const project = actions?.project;
  return (
    <div className={b.card} data-block="pr">
      <div className={b.prTop}>
        <span className={b.tile} aria-hidden>
          <GitPullRequest className={b.icon} />
        </span>
        <span className={b.prTitle}>
          <Truncate size="md" strong>
            {title}
          </Truncate>
          <Text size="xs" tone="quiet" tabular>
            {`${pr.repo} #${String(pr.number)}`}
          </Text>
        </span>
      </div>
      <div className={b.facts}>
        {got.isError && row === undefined ? (
          <Text size="xs" tone="quiet">
            Couldn’t read this PR just now.
          </Text>
        ) : row === undefined ? (
          <Text size="xs" tone="quiet">
            Reading the PR…
          </Text>
        ) : (
          // One quiet line: where it is, its checks, its review, its size, a dot between each. Only a failure takes a colour.
          <span className={b.factLine}>
            {[state === undefined ? null : { text: state.word, tone: state.tone }, checks ?? null, review ?? null]
              .filter((f) => f !== null)
              .map((f, i) => (
                <span key={i} className={b.fact} data-failed={f.tone === "failed" || undefined}>
                  {f.text}
                </span>
              ))}
            {size !== undefined ? (
              <span className={b.fact}>
                <span className={b.add}>+{stat(size.additions ?? 0)}</span> <span className={b.del}>−{stat(size.deletions ?? 0)}</span>
              </span>
            ) : null}
          </span>
        )}
      </div>
      <div className={b.actions}>
        {project !== undefined ? (
          <Button variant="primary" onClick={() => navigate(panelRoute(project, { tab: "prs", pr: { repo: pr.repo, number: pr.number } }))}>
            {changes ? "Open changes" : "Open"}
          </Button>
        ) : null}
        {row !== undefined ? (
          <Button variant="quiet" onClick={() => openExternal(row.url)}>
            GitHub
          </Button>
        ) : null}
      </div>
    </div>
  );
}
