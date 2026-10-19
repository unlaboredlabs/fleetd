// Stress text, written as a person would (no lorem ipsum: wrapped prose has to read like the real thing to judge it).

/** ~250 characters: a done-when criterion with a path, a command and a number, the kind that clipped in the GPUI app. */
export const LONG_CRITERION =
  "The checkout page renders the Team plan's monthly and yearly prices from site/pricing/plans.json, `pnpm test --filter storefront-checkout` passes, and the receipt email shows the prorated amount for a mid-cycle upgrade to the nearest cent";

/** ~120 characters: an order title that has to truncate with a tooltip in single-line slots. */
export const LONG_TITLE =
  "Move invoice and receipt date formatting from moment to the built-in Intl API, and add tests for every locale we ship";

/** More ~120-character titles, so a list of them doesn't repeat one line. */
export const LONG_TITLES = [
  LONG_TITLE,
  "Rewrite the pricing page headline and the Team plan comparison table from the copy review, keeping both variants behind a flag",
  "Add a public read-only snapshot route for share cards with unguessable ids, masked account names and a seven-day expiry",
  "Split the storefront checkout into a server-rendered summary step and a client-side payment step without losing the cart",
  "Make the nightly export job resumable after a crash, write a progress marker per batch and alert when it falls behind",
] as const;

/** A long dotted prompt key, as the hub's prompt ids look. */
export const LONG_PROMPT_KEY = "lead.wake.answers_since_last_wake.with_decisions_and_pending_asks.project_override";

/** A long branch name, as the hub derives them (`fleetd/<task>-<slug>`). */
export const LONG_BRANCH = "fleetd/T14-move-invoice-and-receipt-date-formatting-from-moment-to-intl";

/** A deep file path. */
export const LONG_PATH = "apps/storefront/src/features/checkout/summary/components/receipt-line-items/format-receipt-date.test.ts";

/** A paragraph that must wrap (a question's context, a long message). */
export const LONG_PARAGRAPH =
  "The share card's copy-link button needs a URL people can open without the console's key. The plan: when you click Copy link, the card is saved on the console and served at /share/<id>.png with no login, showing only that frozen image with account names masked unless you turned them on. It only works for viewers who can reach your console's address.";

/** Exactly `n` characters of `text`, repeated as needed, cut at a word boundary where possible. */
export const ofLength = (text: string, n: number): string => {
  let s = text;
  while (s.length < n) s = `${s} ${text}`;
  const cut = s.lastIndexOf(" ", n);
  return cut > n * 0.8 ? s.slice(0, cut) : s.slice(0, n);
};
