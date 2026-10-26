// Screenshot and test data for the Train tab, shaped as the hub's changes_list, pr_list and pr_get return it: one
// repo's train with a PR in CI, a queue in every state (in review, ready, held, sent back), a batch that landed as one
// commit, a refusal and a lone merge. `batch` swaps the head for a batch of three in CI. Fixture data only.
// Value imports carry ".ts": `pnpm fixtures` runs this file under plain Node (fixtures/train/index.ts).
import type { Change, ChangesListInput, ChangesListOutput, ChangeState, PrCheck, PrGetOutput, PrRow, ProjectRef } from "../../../shared/contracts";
import { trainReads } from "./model.ts";

export const TRAIN_REPO = "acme/storefront";

interface Spec {
  readonly number: number;
  readonly title: string;
  readonly branch: string;
  readonly state: ChangeState;
  /** Minutes before now the train last moved it. */
  readonly moved: number;
  readonly position?: number;
  readonly lastError?: string;
  /** Shared by a batch's members. */
  readonly mergedSha?: string;
  readonly checks?: PrRow["checks"];
}

const sha = (n: number): string => n.toString(16).padStart(2, "0").repeat(20);
const url = (n: number): string => `https://github.com/${TRAIN_REPO}/pull/${n}`;

const PASSING = { state: "passing", passed: 7, failed: 0, pending: 0 } as const;

const QUEUE: readonly Spec[] = [
  { number: 21, title: "Gift cards apply before tax", branch: "fleetd/gift-cards-pre-tax", state: "ready", moved: 9, position: 0, checks: PASSING },
  { number: 22, title: "Order emails carry the shop's logo", branch: "fleetd/order-email-logo", state: "reviewing", moved: 14, position: 1, checks: PASSING },
  {
    number: 23,
    title: "Retry webhook deliveries with backoff",
    branch: "fleetd/webhook-backoff",
    state: "ready",
    moved: 31,
    position: 2,
    lastError: "held: the PR has the `hold` label; the train takes it once the label is gone",
    checks: PASSING,
  },
  { number: 24, title: "Inventory counts lock per variant", branch: "fleetd/variant-locks", state: "queued", moved: 3, position: 3, checks: { state: "pending", passed: 4, failed: 0, pending: 3 } },
  {
    number: 19,
    title: "Shipping zones read from the admin",
    branch: "fleetd/shipping-zones",
    state: "needs_rebase",
    moved: 22,
    lastError: "src/shipping/zones.ts, src/shipping/rates.ts",
    checks: PASSING,
  },
];

const RECENT: readonly Spec[] = [
  { number: 18, title: "Cart totals use integer minor units", branch: "fleetd/cart-minor-units", state: "merged", moved: 38, mergedSha: sha(18), checks: PASSING },
  { number: 15, title: "Product pages lazy-load their reviews", branch: "fleetd/lazy-reviews", state: "merged", moved: 125, mergedSha: sha(15), checks: PASSING },
  { number: 16, title: "Search suggests as you type", branch: "fleetd/search-suggest", state: "merged", moved: 125, mergedSha: sha(15), checks: PASSING },
  { number: 17, title: "Fix the sitemap's trailing slashes", branch: "fleetd/sitemap-slashes", state: "merged", moved: 125, mergedSha: sha(15), checks: PASSING },
  {
    number: 14,
    title: "Drop the legacy checkout",
    branch: "fleetd/drop-legacy-checkout",
    state: "refused",
    moved: 190,
    lastError: "The base requires a review from a code owner of src/checkout/. Ask one to approve, then queue it again.",
    checks: PASSING,
  },
  { number: 12, title: "Receipts show the shop's local time", branch: "fleetd/receipt-local-time", state: "merged", moved: 1_510, mergedSha: sha(12), checks: PASSING },
];

const HEAD: readonly Spec[] = [
  { number: 20, title: "Bump the image CDN client", branch: "fleetd/image-cdn-client", state: "ci", moved: 4, checks: { state: "pending", passed: 4, failed: 0, pending: 2 } },
];

const BATCH: readonly Spec[] = [
  { number: 25, title: "Checkout buttons in German and Dutch", branch: "fleetd/checkout-de-nl", state: "ci", moved: 6, checks: PASSING },
  { number: 26, title: "Search index warms on deploy", branch: "fleetd/search-warm", state: "ci", moved: 6, checks: PASSING },
  { number: 27, title: "Coupons show their expiry date", branch: "fleetd/coupon-expiry", state: "ci", moved: 6, checks: PASSING },
];

/** The head's check runs as pr_get has them: two still running, the rest passed. */
const headChecks = (now: number): PrCheck[] => {
  const at = (m: number) => new Date(now - m * 60_000).toISOString();
  return [
    { name: "build", state: "passing", conclusion: "success", startedAt: at(4), completedAt: at(2) },
    { name: "lint", state: "passing", conclusion: "success", startedAt: at(4), completedAt: at(3) },
    { name: "typecheck", state: "passing", conclusion: "success", startedAt: at(4), completedAt: at(3) },
    { name: "unit tests", state: "pending", startedAt: at(4) },
    { name: "e2e (chromium)", state: "pending", startedAt: at(4) },
    { name: "licenses", state: "passing", conclusion: "skipped", startedAt: at(4), completedAt: at(4) },
  ];
};

export interface TrainFixture {
  readonly changes: Change[];
  readonly prs: PrRow[];
  /** pr_get for the PR in flight; none for a batch. */
  readonly heads: PrGetOutput[];
}

/** The train as of `nowIso`; `batch`: three PRs in CI together instead of one. */
export const trainFixture = (project: ProjectRef, nowIso: string, batch = false): TrainFixture => {
  const now = Date.parse(nowIso);
  const ago = (m: number) => new Date(now - m * 60_000).toISOString();
  const head = batch ? BATCH : HEAD;
  const specs = [...head, ...QUEUE, ...RECENT];
  const changes = specs
    .map(
      (p, i): Change => ({
        changeId: `X${p.number}`,
        projectRef: project,
        repo: TRAIN_REPO,
        prNumber: p.number,
        prUrl: url(p.number),
        branch: p.branch,
        headSha: sha(p.number + 100),
        state: p.state,
        reviews: [],
        workstreamId: `W${3 + (i % 3)}`,
        taskId: `T${300 + p.number}`,
        createdAt: ago(p.moved + 60),
        updatedAt: ago(p.moved),
        ...(p.position === undefined ? {} : { position: p.position }),
        ...(p.lastError === undefined ? {} : { lastError: p.lastError }),
        ...(p.mergedSha === undefined ? {} : { mergedSha: p.mergedSha }),
      }),
    )
    // Newest first, as changes_list sends them.
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  const prs = specs.map(
    (p): PrRow => ({
      repo: TRAIN_REPO,
      number: p.number,
      url: url(p.number),
      title: p.title,
      branch: p.branch,
      state: p.state === "merged" ? "merged" : p.state === "refused" ? "closed" : "open",
      author: { role: "implementer", profile: "high" },
      review: { state: "approved", done: 1, needed: 1 },
      createdAt: ago(p.moved + 60),
      updatedAt: ago(p.moved),
      ...(p.state === "merged" ? { mergedAt: ago(p.moved) } : {}),
      ...(p.checks === undefined ? {} : { checks: p.checks }),
    }),
  );
  // A batch's checks run on the train's own PR, so the pane asks only a lone head's.
  const heads = prs
    .filter((r) => !batch && head.some((h) => h.number === r.number))
    .map(
      (pr): PrGetOutput => ({
        pr,
        body: "",
        checks: headChecks(now),
        reviews: [],
        history: [],
        links: { pr: pr.url, checks: `${pr.url}/checks`, files: `${pr.url}/files` },
      }),
    );
  return { changes, prs, heads };
};

/** changes_list's answer to each of the pane's reads (model.ts trainReads), as the hub would give it. */
export const changesAnswers = (project: ProjectRef, changes: readonly Change[]): Array<{ readonly input: ChangesListInput; readonly output: ChangesListOutput }> =>
  trainReads(project).map((input) => {
    const of = changes.filter((c) => c.state === input.state);
    const limit = input.limit ?? 50;
    return { input, output: { changes: of.slice(0, limit), ...(of.length > limit ? { truncated: true } : {}) } };
  });
