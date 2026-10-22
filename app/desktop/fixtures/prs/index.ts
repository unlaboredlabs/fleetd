// The PR screens' answers (pr_list, pr_get, pr_files, pr_diff) for the first project, storefront: open PRs in every
// state on their way to main (in review, checks failed, next in line, a draft, one fleetd doesn't merge), and one
// merged and one closed lately, with descriptions, checks, agent and people's reviews, files and real-looking diffs.
// Added to the shared fixtures; the group's own cover no PRs, the reads still on their way, GitHub out of reach, a PR
// that fails to load, and a PR of 240 files with a 3,000-line file, paged as the hub pages them.
//
// The tools' contract is still on its branch (src/renderer/src/data/pr-contract.ts), so their answers skip schema
// validation until it lands here.
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { firstProject } from "../kit/chat.ts";
import type { JsonObject } from "../kit/json.ts";
import { LONG_BRANCH, LONG_PARAGRAPH, LONG_PATH, LONG_TITLES, ofLength } from "../kit/text.ts";

const REPO = "acme/storefront";
const TOOLS = ["pr_list", "pr_get", "pr_files", "pr_diff"] as const;
/** Files per pr_files page and lines per pr_diff page, as the hub sends them. */
const FILES_PAGE = 100;
const DIFF_PAGE = 200;

const ago = (f: Fixture, minutes: number): string => new Date(Date.parse(f.now) - minutes * 60_000).toISOString();
const url = (n: number) => `https://github.com/${REPO}/pull/${n}`;

/** A unified diff's body as the hub's lines: hunk headers carry their start lines and trailing context. */
export const diffLines = (patch: string): JsonObject[] => {
  const out: JsonObject[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of patch.replace(/^\n/u, "").replace(/\n$/u, "").split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/u.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      out.push({ kind: "hunk", text: hunk[3] ?? "", old: oldNo, new: newNo });
    } else if (line.startsWith("+")) out.push({ kind: "add", text: line.slice(1), new: newNo++ });
    else if (line.startsWith("-")) out.push({ kind: "del", text: line.slice(1), old: oldNo++ });
    else out.push({ kind: "context", text: line.slice(1), old: oldNo++, new: newNo++ });
  }
  return out;
};

interface FileSpec {
  readonly path: string;
  readonly status?: string;
  readonly previousPath?: string;
  /** Undefined: GitHub shows no diff (binary, or too large). */
  readonly patch?: string;
}

const FORMAT_TS = `
@@ -1,18 +1,27 @@
-import moment from "moment";
+import type { Shop } from "../shop/types";

-/** "Oct 19, 2026 10:30" in the server's zone. */
-export function formatReceiptDate(iso: string): string {
-  return moment(iso).format("MMM D, YYYY HH:mm");
+const formats = new Map<string, Intl.DateTimeFormat>();
+
+/** "19 Oct 2026, 10:30" in the shop's own time zone and locale, whatever the server's. */
+export function formatReceiptDate(iso: string, shop: Pick<Shop, "locale" | "timeZone">): string {
+  const key = \`\${shop.locale}|\${shop.timeZone}\`;
+  let format = formats.get(key);
+  if (format === undefined) {
+    format = new Intl.DateTimeFormat(shop.locale, { dateStyle: "medium", timeStyle: "short", timeZone: shop.timeZone });
+    formats.set(key, format);
+  }
+  return format.format(new Date(iso));
 }

 export function formatReceiptLine(line: ReceiptLine, shop: Shop): string {
   const amount = formatMoney(line.amountMinor, shop.currency);
-  return \`\${line.label} · \${amount} · \${formatReceiptDate(line.at)}\`;
+  return \`\${line.label} · \${amount} · \${formatReceiptDate(line.at, shop)}\`;
 }

 // Older receipts were stored with a local time and no offset; they stay as they were printed.
 export function isLegacyReceipt(r: Receipt): boolean {
   return r.version < 3;
 }
@@ -41,9 +50,11 @@ export function receiptTotals(r: Receipt) {
   const subtotal = r.lines.reduce((n, l) => n + l.amountMinor, 0);
   const tax = Math.round(subtotal * r.taxRate);
-  return { subtotal, tax, total: subtotal + tax, printedAt: formatReceiptDate(r.printedAt) };
+  // Printed in the shop's zone: a receipt printed at 23:30 in Sydney is dated that day, not the server's.
+  const printedAt = formatReceiptDate(r.printedAt, r.shop);
+  return { subtotal, tax, total: subtotal + tax, printedAt };
 }
`;

const FORMAT_TEST = `
@@ -0,0 +1,24 @@
+import { describe, expect, it } from "vitest";
+import { formatReceiptDate } from "./format";
+
+const sydney = { locale: "en-AU", timeZone: "Australia/Sydney" };
+const berlin = { locale: "de-DE", timeZone: "Europe/Berlin" };
+
+describe("formatReceiptDate", () => {
+  it("dates a late order on the shop's own day", () => {
+    expect(formatReceiptDate("2026-10-19T13:30:00Z", sydney)).toBe("20 Oct 2026, 12:30 am");
+  });
+
+  it("uses the shop's locale", () => {
+    expect(formatReceiptDate("2026-10-19T08:05:00Z", berlin)).toBe("19.10.2026, 10:05");
+  });
+
+  it("survives a daylight-saving change", () => {
+    expect(formatReceiptDate("2026-10-25T00:30:00Z", berlin)).toBe("25.10.2026, 02:30");
+    expect(formatReceiptDate("2026-10-25T01:30:00Z", berlin)).toBe("25.10.2026, 02:30");
+  });
+
+  it("reuses one formatter per shop", () => {
+    expect(formatReceiptDate("2026-10-19T08:05:00Z", berlin)).toBe(formatReceiptDate("2026-10-19T08:05:00Z", berlin));
+  });
+});
`;

const SHOP_TYPES = `
@@ -4,6 +4,8 @@ export interface Shop {
   readonly name: string;
   readonly currency: CurrencyCode;
   readonly locale: string;
+  /** IANA zone the shop trades in, e.g. "Europe/Berlin"; receipts and invoices are dated in it. */
+  readonly timeZone: string;
   readonly taxRate: number;
 }

`;

const MIGRATION = `
@@ -0,0 +1,6 @@
+-- Every shop trades in a time zone; existing shops take the zone of their billing address, else UTC.
+ALTER TABLE shops ADD COLUMN time_zone TEXT NOT NULL DEFAULT 'UTC';
+UPDATE shops SET time_zone = addresses.time_zone
+  FROM addresses
+  WHERE addresses.id = shops.billing_address_id AND addresses.time_zone IS NOT NULL;
+CREATE INDEX shops_time_zone ON shops (time_zone);
`;

const PACKAGE_JSON = `
@@ -14,7 +14,6 @@
     "@acme/ui": "workspace:*",
     "dinero.js": "2.0.0",
-    "moment": "2.30.1",
     "react": "19.3.0",
     "react-dom": "19.3.0",
     "zod": "4.6.7"
`;

const TOTALS_RS = `
@@ -1,12 +1,14 @@
-/// A cart's total in dollars.
-pub fn total(lines: &[Line]) -> f64 {
-    lines.iter().map(|l| l.price * l.qty as f64).sum()
+/// A cart's total in the currency's minor units (cents), so no sum ever drifts by a fraction of a cent.
+pub fn total(lines: &[Line]) -> i64 {
+    lines.iter().map(|l| l.price_minor * i64::from(l.qty)).sum()
 }

-pub fn with_tax(total: f64, rate: f64) -> f64 {
-    (total * (1.0 + rate) * 100.0).round() / 100.0
+/// Tax rounds half to even, as the tax office's own calculator does.
+pub fn with_tax(total_minor: i64, rate_bp: i64) -> i64 {
+    let tax = total_minor * rate_bp;
+    total_minor + round_half_even(tax, 10_000)
 }

 #[cfg(test)]
@@ -20,8 +22,16 @@ mod tests {
     #[test]
     fn sums_lines() {
-        assert_eq!(total(&[line(9.99, 3)]), 29.97);
+        assert_eq!(total(&[line(999, 3)]), 2997);
     }
+
+    #[test]
+    fn rounds_half_even() {
+        assert_eq!(with_tax(1_000, 1_250), 1_125);
+        assert_eq!(with_tax(1_004, 1_250), 1_130);
+        assert_eq!(with_tax(1_012, 1_250), 1_138);
+    }
 }
`;

const ROUNDING_RS = `
@@ -0,0 +1,15 @@
+/// \`n / d\` rounded to the nearest integer, halves to the even neighbour (banker's rounding).
+pub fn round_half_even(n: i64, d: i64) -> i64 {
+    let q = n.div_euclid(d);
+    let r = n.rem_euclid(d);
+    match (2 * r).cmp(&d) {
+        std::cmp::Ordering::Less => q,
+        std::cmp::Ordering::Greater => q + 1,
+        std::cmp::Ordering::Equal => {
+            if q % 2 == 0 {
+                q
+            } else {
+                q + 1
+            }
+        }
+    }
+}
`;

const SEARCH_TS = `
@@ -8,6 +8,14 @@ export async function deploy(env: Env): Promise<void> {
   await migrate(env.db);
   await swapRelease(env);
+  // The first searches after a deploy were slow: the index loaded on first use. Load it now, in the background,
+  // and serve from the old index until it is warm.
+  void warmIndex(env).catch((error: unknown) => log.warn("search index didn't warm", { error }));
 }
+
+async function warmIndex(env: Env): Promise<void> {
+  const index = await openIndex(env.searchBucket);
+  await index.query({ text: "", limit: 1 });
+}
`;

const CHECKOUT_COPY = `
@@ -12,7 +12,9 @@
   "checkout.pay": "Pay now",
-  "checkout.pay.de": "Jetzt zahlen",
+  "checkout.pay.de": "Jetzt bezahlen",
+  "checkout.pay.nl": "Nu betalen",
   "checkout.back": "Back to cart",
-  "checkout.back.de": "Zurück",
+  "checkout.back.de": "Zurück zum Warenkorb",
+  "checkout.back.nl": "Terug naar winkelwagen",
   "checkout.total": "Total"
`;

interface PrSpec {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "draft" | "merged" | "closed";
  readonly branch?: string;
  readonly queue?: JsonObject;
  readonly checks?: JsonObject | undefined;
  readonly review: JsonObject;
  readonly author: JsonObject;
  readonly created: number;
  readonly updated: number;
  readonly merged?: number;
  readonly body: string;
  readonly checkRuns: JsonObject[];
  readonly reviews: JsonObject[];
  readonly history: JsonObject[];
  readonly files: readonly FileSpec[];
}

const implementer = (title: string, model = "claude-opus-5-5"): JsonObject => ({ role: "implementer", title, model, effort: "high", login: "acme-fleet" });
const reviewer = (model: string, role = "reviewer"): JsonObject => ({ role, model });

const check = (f: Fixture, name: string, state: string, startedMin: number, tookS: number | undefined, conclusion?: string): JsonObject => ({
  name,
  state,
  ...(conclusion === undefined ? {} : { conclusion }),
  url: `https://github.com/${REPO}/actions/runs/1${name.length}${startedMin}`,
  startedAt: ago(f, startedMin),
  ...(tookS === undefined ? {} : { completedAt: new Date(Date.parse(ago(f, startedMin)) + tookS * 1000).toISOString() }),
});

const passing = (f: Fixture, at: number): JsonObject[] => [
  check(f, "lint", "passing", at, 63, "success"),
  check(f, "typecheck", "passing", at, 139, "success"),
  check(f, "unit (ubuntu)", "passing", at, 312, "success"),
  check(f, "rust (ubuntu)", "passing", at, 401, "success"),
  check(f, "build", "passing", at, 254, "success"),
  check(f, "e2e (chromium)", "passing", at, 488, "success"),
  check(f, "docs", "none", at, undefined, "skipped"),
];

const specs = (f: Fixture): PrSpec[] => [
  {
    number: 11,
    title: "Receipts show the shop's local time",
    state: "open",
    branch: "fleetd/receipts-local-time",
    queue: { changeId: "C11", state: "reviewing", length: 2, paused: false },
    checks: { state: "pending", passed: 6, failed: 0, pending: 1 },
    review: { state: "pending", done: 1, needed: 3 },
    author: implementer("Date receipts in the shop's time zone"),
    created: 95,
    updated: 6,
    body: [
      "Receipts were dated in the server's zone, so a late order in Sydney printed the day before.",
      "",
      "- Dates use `Intl.DateTimeFormat` in the shop's own zone and locale, one formatter per shop.",
      "- Shops get a `time_zone` column, filled from their billing address.",
      "- `moment` is gone from the storefront bundle (−72 kB).",
      "",
      "Older receipts (version < 3) keep the time they were printed with.",
    ].join("\n"),
    checkRuns: [
      check(f, "lint", "passing", 40, 61, "success"),
      check(f, "typecheck", "passing", 40, 141, "success"),
      check(f, "unit (ubuntu)", "passing", 40, 305, "success"),
      check(f, "build", "passing", 40, 247, "success"),
      check(f, "rust (ubuntu)", "passing", 40, 398, "success"),
      check(f, "e2e (chromium)", "pending", 9, undefined),
      check(f, "migrations", "passing", 40, 88, "success"),
      check(f, "docs", "none", 40, undefined, "skipped"),
    ],
    reviews: [
      {
        verdict: "changes_requested",
        agent: reviewer("claude-opus-5-5"),
        blocking: 1,
        nonBlocking: 1,
        text: [
          "**Blocking**",
          "",
          "1. `src/receipts/format.ts`: `formats` grows with every shop and never shrinks. Fine for one shop per process, but the worker serves all of them; cap it or key by zone and locale only.",
          "",
          "**Suggestion**",
          "",
          "1. The daylight-saving test checks both sides of the change, but not a zone with a 30-minute offset (`Australia/Adelaide`).",
        ].join("\n"),
        current: true,
        at: ago(f, 12),
      },
      {
        verdict: "approved",
        agent: reviewer("claude-opus-5-5", "verifier"),
        blocking: 0,
        nonBlocking: 0,
        text: "Ran the receipts end to end for three shops in different zones; every date matched the shop's clock.",
        current: true,
        at: ago(f, 20),
      },
    ],
    history: [
      { at: ago(f, 30), from: "queued", to: "reviewing" },
      { at: ago(f, 31), from: "queued", to: "queued" },
    ],
    files: [
      { path: "src/receipts/format.ts", patch: FORMAT_TS },
      { path: "src/receipts/format.test.ts", status: "added", patch: FORMAT_TEST },
      { path: "src/shop/types.ts", patch: SHOP_TYPES },
      { path: "db/migrations/0042_shop_time_zone.sql", status: "added", patch: MIGRATION },
      { path: "package.json", patch: PACKAGE_JSON },
      { path: "public/receipt-logo.png", status: "modified" },
    ],
  },
  {
    number: 10,
    title: "Cart totals use integer minor units",
    state: "open",
    branch: "fleetd/cart-minor-units",
    queue: {
      changeId: "C10",
      state: "ci_failed",
      length: 2,
      paused: false,
      reason: "`rust (macos)` failed: `cart::totals::tests::rounds_half_even` expected 1130, got 1131.",
    },
    checks: { state: "failing", passed: 6, failed: 1, pending: 0 },
    review: { state: "approved", done: 3, needed: 3 },
    author: implementer("Keep cart money in cents"),
    created: 260,
    updated: 18,
    body: "Cart and tax maths move from floating-point dollars to integer cents, and tax rounds half to even.\n\nFixes the one-cent drift on carts with many lines.",
    checkRuns: [
      check(f, "rust (macos)", "failing", 25, 422, "failure"),
      ...passing(f, 25).slice(0, 6),
      check(f, "docs", "none", 25, undefined, "skipped"),
      check(f, "e2e (webkit)", "none", 25, undefined, "cancelled"),
    ],
    reviews: [
      { verdict: "approved", agent: reviewer("claude-opus-5-5"), blocking: 0, nonBlocking: 1, text: "Suggestion: `round_half_even` could live with the currency code, so other callers find it.", current: true, at: ago(f, 40) },
      { verdict: "approved", agent: reviewer("claude-opus-5-5", "verifier"), blocking: 0, nonBlocking: 0, text: "Checked 2,000 random carts against the old totals: identical but for the half-cent cases, which now round to even.", current: true, at: ago(f, 44) },
      { verdict: "approved", agent: reviewer("claude-opus-5-5", "qa"), blocking: 0, nonBlocking: 0, text: "Checkout, refunds and the receipt email all show the same totals.", current: true, at: ago(f, 47) },
      {
        verdict: "changes_requested",
        agent: reviewer("claude-opus-5-5"),
        blocking: 2,
        nonBlocking: 0,
        text: "1. `with_tax` still takes the rate as a float.\n2. No test for a negative total (a refund).",
        current: false,
        at: ago(f, 120),
      },
    ],
    history: [
      { at: ago(f, 18), from: "ci", to: "ci_failed" },
      { at: ago(f, 26), from: "rebasing", to: "ci" },
      { at: ago(f, 28), from: "ready", to: "rebasing" },
      { at: ago(f, 39), from: "reviewing", to: "ready" },
      { at: ago(f, 118), from: "queued", to: "reviewing" },
      { at: ago(f, 250), from: "queued", to: "queued" },
    ],
    files: [
      { path: "crates/cart/src/totals.rs", patch: TOTALS_RS },
      { path: "crates/cart/src/rounding.rs", status: "added", patch: ROUNDING_RS },
    ],
  },
  {
    number: 9,
    title: "Search index warms on deploy",
    state: "open",
    branch: "fleetd/search-warm",
    queue: { changeId: "C9", state: "ready", position: 0, length: 2, paused: false },
    checks: { state: "passing", passed: 6, failed: 0, pending: 0 },
    review: { state: "approved", done: 2, needed: 2 },
    author: implementer("Warm the search index on deploy", "claude-opus-5-5"),
    created: 180,
    updated: 9,
    body: "The first searches after a deploy took seconds while the index loaded. It now loads in the background during the deploy.",
    checkRuns: passing(f, 15),
    reviews: [
      { verdict: "approved", agent: reviewer("claude-opus-5-5"), blocking: 0, nonBlocking: 0, text: "Looks right; the old index serves until the new one answers.", current: true, at: ago(f, 11) },
      { verdict: "approved", agent: reviewer("claude-opus-5-5", "verifier"), blocking: 0, nonBlocking: 0, text: "First search after a staging deploy: 140 ms, was 3.8 s.", current: true, at: ago(f, 10) },
    ],
    history: [
      { at: ago(f, 9), from: "reviewing", to: "ready" },
      { at: ago(f, 60), from: "queued", to: "reviewing" },
    ],
    files: [{ path: "src/deploy/search.ts", patch: SEARCH_TS }],
  },
  {
    number: 12,
    title: "Bump the image CDN client",
    state: "open",
    branch: "deps/image-cdn-4",
    checks: { state: "passing", passed: 5, failed: 0, pending: 0 },
    review: { state: "none", done: 0, needed: 0 },
    author: { login: "dependabot" },
    created: 1500,
    updated: 1440,
    body: "Bumps the image CDN client from 3.9.2 to 4.0.1.",
    checkRuns: passing(f, 1450).slice(0, 5),
    reviews: [],
    history: [],
    files: [{ path: "package.json", patch: PACKAGE_JSON.replace('-    "moment": "2.30.1",', '-    "@acme/image-cdn": "3.9.2",\n+    "@acme/image-cdn": "4.0.1",') }],
  },
  {
    // A person's PR fleetd doesn't merge, waiting on a review someone asked for on GitHub.
    number: 14,
    title: "Checkout buttons in German and Dutch",
    state: "open",
    branch: "copy/checkout-de-nl",
    checks: { state: "passing", passed: 5, failed: 0, pending: 0 },
    review: { state: "pending", done: 0, needed: 0 },
    author: { login: "acme-design" },
    created: 300,
    updated: 25,
    body: "The pay and back buttons read naturally in German, and checkout gets its Dutch copy.\n\nAsked the localisation team to review the wording.",
    checkRuns: passing(f, 30).slice(0, 5),
    reviews: [],
    history: [],
    files: [{ path: "src/i18n/checkout.json", patch: CHECKOUT_COPY }],
  },
  {
    number: 8,
    title: "Receipt dates use Intl",
    state: "merged",
    branch: "fleetd/receipt-intl",
    queue: { changeId: "C8", state: "merged", length: 0, paused: false },
    checks: { state: "passing", passed: 7, failed: 0, pending: 0 },
    review: { state: "approved", done: 2, needed: 2 },
    author: implementer("Format receipt dates with Intl"),
    created: 400,
    updated: 44,
    merged: 44,
    body: "First half of dropping `moment`: receipt dates go through `Intl`.",
    checkRuns: passing(f, 60),
    reviews: [{ verdict: "approved", agent: reviewer("claude-opus-5-5"), blocking: 0, nonBlocking: 0, text: "Good.", current: true, at: ago(f, 70) }],
    history: [
      { at: ago(f, 44), from: "merging", to: "merged" },
      { at: ago(f, 46), from: "ci", to: "merging" },
      { at: ago(f, 55), from: "rebasing", to: "ci" },
      { at: ago(f, 56), from: "ready", to: "rebasing" },
      { at: ago(f, 69), from: "reviewing", to: "ready" },
    ],
    files: [{ path: "src/receipts/format.ts", patch: FORMAT_TS }],
  },
  {
    number: 7,
    title: "Try a second payment provider",
    state: "closed",
    branch: "fleetd/second-provider",
    queue: { changeId: "C7", state: "abandoned", length: 0, paused: false, reason: "The lead dropped it: the provider has no refunds API." },
    checks: { state: "passing", passed: 7, failed: 0, pending: 0 },
    review: { state: "pending", done: 0, needed: 2 },
    author: implementer("Spike a second payment provider", "claude-opus-5-5"),
    created: 2900,
    updated: 1700,
    body: "A spike: checkout can pay through a second provider behind a flag.",
    checkRuns: passing(f, 2800),
    reviews: [],
    history: [{ at: ago(f, 1700), from: "reviewing", to: "abandoned" }],
    files: [{ path: "src/payments/provider.ts", patch: SEARCH_TS }],
  },
];

const rowOf = (f: Fixture, p: PrSpec): JsonObject => ({
  repo: REPO,
  number: p.number,
  url: url(p.number),
  title: p.title,
  state: p.state,
  ...(p.checks === undefined ? {} : { checks: p.checks }),
  review: p.review,
  ...(p.queue === undefined ? {} : { queue: p.queue }),
  author: p.author,
  ...(p.branch === undefined ? {} : { branch: p.branch }),
  createdAt: ago(f, p.created),
  updatedAt: ago(f, p.updated),
  ...(p.merged === undefined ? {} : { mergedAt: ago(f, p.merged) }),
});

const fileOf = (s: FileSpec): JsonObject => {
  const lines = s.patch === undefined ? undefined : diffLines(s.patch);
  const count = (kind: string) => lines?.filter((l) => l["kind"] === kind).length ?? 0;
  return {
    path: s.path,
    ...(s.previousPath === undefined ? {} : { previousPath: s.previousPath }),
    status: s.status ?? "modified",
    additions: s.patch === undefined ? 0 : count("add"),
    deletions: s.patch === undefined ? 0 : count("del"),
    ...(lines === undefined ? {} : { diffLines: lines.length }),
  };
};

/** Answers pr_files page by page and pr_diff for every page of every file, as the hub would. */
const answerFiles = (f: Fixture, number: number, files: readonly FileSpec[], headSha: string): void => {
  const stats = files.map(fileOf);
  for (let offset = 0; offset < Math.max(1, stats.length); offset += FILES_PAGE) {
    const page = stats.slice(offset, offset + FILES_PAGE);
    const next = offset + FILES_PAGE < stats.length ? { nextOffset: offset + FILES_PAGE } : {};
    f.answer("pr_files", { repo: REPO, number, ...(offset === 0 ? {} : { offset }) }, { files: page, total: stats.length, headSha, ...next });
  }
  for (const s of files) {
    if (s.patch === undefined) continue;
    const lines = diffLines(s.patch);
    for (let offset = 0; offset < lines.length; offset += DIFF_PAGE) {
      const next = offset + DIFF_PAGE < lines.length ? { nextOffset: offset + DIFF_PAGE } : {};
      f.answer("pr_diff", { repo: REPO, number, path: s.path, offset }, { lines: lines.slice(offset, offset + DIFF_PAGE), total: lines.length, headSha, ...next });
    }
  }
};

const answerPr = (f: Fixture, p: PrSpec, githubError?: string): void => {
  const files = p.files.map(fileOf);
  const additions = files.reduce((n, x) => n + Number(x["additions"]), 0);
  const deletions = files.reduce((n, x) => n + Number(x["deletions"]), 0);
  const headSha = `${p.number}`.padStart(40, "a");
  f.answer("pr_get", { repo: REPO, number: p.number }, {
    pr: rowOf(f, p),
    body: p.body,
    baseBranch: "main",
    headSha,
    // Only GitHub knows the diff's size.
    ...(githubError === undefined ? { additions, deletions, changedFiles: files.length } : {}),
    checks: p.checkRuns,
    reviews: p.reviews,
    history: p.history,
    links: { pr: url(p.number), files: `${url(p.number)}/files`, checks: `${url(p.number)}/checks` },
    ...(githubError === undefined ? {} : { githubError }),
  });
  answerFiles(f, p.number, p.files, headSha);
};

const pending = (f: Fixture): void => {
  for (const tool of TOOLS) f.pendingContracts.set(tool, "the PR reads land with the hub's PR view (crates/fleetd-contracts/src/prs.rs)");
};

const answerAll = (f: Fixture, list: readonly PrSpec[], opts: { githubError?: string } = {}): void => {
  pending(f);
  const projectRef = firstProject(f);
  f.answer("pr_list", { projectRef }, { at: f.now, prs: list.map((p) => rowOf(f, p)), ...(opts.githubError === undefined ? {} : { githubError: opts.githubError }) });
  for (const p of list) answerPr(f, p, opts.githubError);
};

/** The long-text variant: titles, branch, paths, check names and review text at their limits. */
const longSpecs = (f: Fixture): PrSpec[] =>
  specs(f).map((p, i) => ({
    ...p,
    title: ofLength(`${LONG_TITLES[i % LONG_TITLES.length] ?? p.title} ${LONG_TITLES[(i + 1) % LONG_TITLES.length] ?? ""}`, 290),
    branch: LONG_BRANCH,
    body: `${p.body}\n\n${LONG_PARAGRAPH}\n\n${LONG_PARAGRAPH}`,
    checkRuns: [check(f, ofLength("integration tests (ubuntu-latest, node 24, postgres 17, with the payments sandbox)", 190), "failing", 30, 932, "timed_out"), ...p.checkRuns],
    reviews: p.reviews.map((r) => ({ ...r, text: ofLength(`${typeof r["text"] === "string" ? r["text"] : ""} ${LONG_PARAGRAPH}`, 1900) })),
    files: [{ path: LONG_PATH, status: "renamed", previousPath: LONG_PATH.replace("receipt-line-items", "line-items"), patch: FORMAT_TEST }, ...p.files],
  }));

/** The heavy PR: 240 files (three pages of them), one a 3,000-line rewrite read 200 lines at a time. */
const heavySpec = (f: Fixture): PrSpec => {
  const base = specs(f)[0];
  if (base === undefined) throw new Error("no PR specs");
  const big = ["@@ -1,1500 +1,1500 @@ export const RATES = {"];
  for (let i = 0; i < 1500; i++) {
    big.push(`-  "${String(i).padStart(4, "0")}": { rate: ${(i % 97) / 100}, region: "eu-${i % 7}" },`);
    big.push(`+  "${String(i).padStart(4, "0")}": { rateBp: ${(i % 97) * 100}, region: "eu-${i % 7}" },`);
  }
  const files: FileSpec[] = [{ path: "src/tax/rates.generated.ts", patch: big.join("\n").replace(/^/u, "\n") }];
  for (let i = 0; i < 239; i++) {
    const dir = ["checkout", "cart", "receipts", "search", "payments", "shop"][i % 6] ?? "shop";
    files.push({ path: `src/${dir}/money-${String(i).padStart(3, "0")}.ts`, patch: TOTALS_RS.replace(/total\(/gu, `total${i}(`) });
  }
  return { ...base, number: 13, title: "Every money value is an integer number of cents", branch: "fleetd/cents-everywhere", files, updated: 3 };
};

export default defineGroup({
  extend: {
    typical: (f) => answerAll(f, specs(f)),
    "many-agents": (f) => answerAll(f, specs(f)),
    "long-text": (f) => answerAll(f, longSpecs(f)),
  },
  fixtures: (base) => [
    (() => {
      const f = Fixture.from(base("typical"), "prs-none", "storefront has no PRs open or closed lately.");
      pending(f);
      f.answer("pr_list", { projectRef: firstProject(f) }, { at: f.now, prs: [] });
      return f;
    })(),
    (() => {
      const f = Fixture.from(base("typical"), "prs-loading", "The PR list and every PR still on their way from the hub.");
      answerAll(f, specs(f));
      for (const a of f.answers("pr_list")) f.answer("pr_list", a.input, a.output, 600_000);
      for (const a of f.answers("pr_get")) f.answer("pr_get", a.input, a.output, 600_000);
      return f;
    })(),
    (() => {
      const f = Fixture.from(base("typical"), "prs-no-github", "GitHub can't be reached: the PRs fleetd made, without checks or descriptions.");
      const list = specs(f)
        .filter((p) => p.queue !== undefined)
        .map((p) => ({ ...p, checks: undefined, body: "", checkRuns: [], files: [] }));
      answerAll(f, list, { githubError: "GitHub didn't answer within 10 seconds. fleetd tries again on the next change; check this machine's network if it keeps failing." });
      return f;
    })(),
    (() => {
      const f = Fixture.from(base("typical"), "prs-error", "#11 fails to load.");
      answerAll(f, specs(f));
      f.drop("pr_get", { repo: REPO, number: 11 });
      f.fail("pr_get", { repo: REPO, number: 11 }, { code: "unavailable", message: "GitHub returned 502 Bad Gateway" });
      return f;
    })(),
    (() => {
      const f = Fixture.from(base("typical"), "prs-heavy", "A PR of 240 files, one of them a 3,000-line rewrite, paged as the hub pages them.");
      answerAll(f, [heavySpec(f), ...specs(f)]);
      return f;
    })(),
  ],
});
