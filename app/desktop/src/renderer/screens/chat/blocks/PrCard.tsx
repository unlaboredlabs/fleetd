// A PR card: its live state from the hub (pr_get, the PR view's own read, refetched on its events), so it reads the
// same as the PR list: where it is on its way to main, its checks, its review, its size. Open shows it in the panel
// beside the chat; merging is fleetd's, never a button here.
import { GitPullRequest } from "lucide-react";
import type { PrBlock } from "../../../../shared/contracts";
import { useToolQuery } from "../../../src/data/react";
import { Button, StatusChip, Text, Truncate } from "../../../ui";
import { openExternal } from "../../prs/PrDetail";
import { checksWord, reviewsWord, stat, stateLine } from "../../prs/words";
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
  const review = row === undefined ? undefined : reviewsWord(row.review);
  const title = row?.title ?? pr.title ?? `Pull request ${String(pr.number)}`;
  const size = got.data?.additions !== undefined && got.data.deletions !== undefined ? got.data : undefined;
  const project = actions?.project;
  return (
    <div className={b.card} data-block="pr">
      <div className={b.prTop}>
        <GitPullRequest className={b.icon} aria-hidden />
        <span className={b.prTitle}>
          <Truncate size="md" strong>
            {title}
          </Truncate>
          <Text size="xs" tone="quiet" tabular>
            {`${pr.repo} #${String(pr.number)}`}
          </Text>
        </span>
        {state !== undefined ? <StatusChip tone={state.tone}>{state.word}</StatusChip> : null}
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
          <>
            {checks !== undefined ? <StatusChip tone={checks.tone}>{checks.text}</StatusChip> : null}
            {review !== undefined ? <StatusChip tone={review.tone}>{review.text}</StatusChip> : null}
            {size !== undefined ? (
              <span className={b.stat}>
                <span className={b.add}>+{stat(size.additions ?? 0)}</span>
                <span className={b.del}>−{stat(size.deletions ?? 0)}</span>
              </span>
            ) : null}
          </>
        )}
      </div>
      <div className={b.actions}>
        {project !== undefined ? (
          <Button variant="secondary" onClick={() => navigate(panelRoute(project, { tab: "prs", pr: { repo: pr.repo, number: pr.number } }))}>
            {changes ? "Open changes" : "Open"}
          </Button>
        ) : null}
        {row !== undefined ? (
          <Button variant="ghost" onClick={() => openExternal(row.url)}>
            GitHub
          </Button>
        ) : null}
      </div>
    </div>
  );
}
