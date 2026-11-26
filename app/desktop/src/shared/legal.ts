// What the App Store asks every app to reach (guideline 5.1.1): fleetd's privacy policy, terms and support pages, opened
// in the system browser from Settings and the phone's first screen; and Delete account's words, the same on the
// desktop, the web app and the phone. Before it asks, each app reads what the delete would take
// (ACCOUNTS_ACCOUNT_PATH's preview): the workspaces that go with the account and any plan that stops with them, those
// the person leaves, and those that hold it back (the only owner of a workspace with others in it).

/** fleetd.sh's pages, in the order Settings lists them. */
export const LEGAL_PAGES = [
  { id: "privacy", title: "Privacy policy", url: "https://fleetd.sh/privacy" },
  { id: "terms", title: "Terms of service", url: "https://fleetd.sh/terms" },
  { id: "support", title: "Support", url: "https://fleetd.sh/support" },
] as const;

export type LegalPage = (typeof LEGAL_PAGES)[number];

/** A workspace that goes with the account. */
export interface DeletedWorkspace {
  readonly name: string;
  readonly plan: string | null;
  /** Credits left there, in cents, lost with it; absent from an older cloud. */
  readonly creditsCents?: number;
  /** Some of them were bought in the last 14 days, so still refundable. */
  readonly refundable?: boolean;
}

/** What deleting the account would take, as the cloud answers it before anything is deleted. */
export interface AccountPreview {
  readonly email: string;
  /** The workspaces the person alone is in: they go with the account, and a plan on one stops. */
  readonly deletes: ReadonlyArray<DeletedWorkspace>;
  /** The workspaces the person leaves. */
  readonly leaves: readonly string[];
  /** The workspaces where the person is the only owner and others are members: the delete is refused while any is. */
  readonly blocked: readonly string[];
}

const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((s) => typeof s === "string") ? v : null);

/** The preview's answer, or null when it isn't one. */
export const readPreview = (json: unknown): AccountPreview | null => {
  if (typeof json !== "object" || json === null) return null;
  const o = json as Record<string, unknown>;
  const leaves = strings(o.leaves);
  const blocked = strings(o.blocked);
  if (typeof o.email !== "string" || !Array.isArray(o.deletes) || leaves === null || blocked === null) return null;
  const deletes: DeletedWorkspace[] = [];
  for (const d of o.deletes as unknown[]) {
    const w = typeof d === "object" && d !== null ? (d as Record<string, unknown>) : null;
    if (w === null || typeof w.name !== "string" || (w.plan !== null && w.plan !== undefined && typeof w.plan !== "string")) return null;
    const credits = typeof w.creditsCents === "number" && Number.isFinite(w.creditsCents) && w.creditsCents > 0 ? Math.round(w.creditsCents) : undefined;
    deletes.push({
      name: w.name,
      plan: typeof w.plan === "string" ? w.plan : null,
      ...(credits === undefined ? {} : { creditsCents: credits }),
      ...(w.refundable === true ? { refundable: true } : {}),
    });
  }
  return { email: o.email, deletes, leaves, blocked };
};

const list = (names: readonly string[]): string => (names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] ?? ""}`);

/** What the delete takes, a line each, in the order it happens. */
export const deleteAccountLines = (preview: AccountPreview): string[] => [
  ...(preview.leaves.length === 0 ? [] : [`You leave ${list(preview.leaves)}.`]),
  ...(preview.deletes.length === 0
    ? []
    : [
        preview.deletes.length === 1
          ? `${preview.deletes[0]?.name ?? ""} is deleted with it, as you're its only member: its bots, chats, memory and vault go for good.`
          : `${list(preview.deletes.map((d) => d.name))} are deleted with it, as you're their only member: their bots, chats, memory and vault go for good.`,
      ]),
  ...preview.deletes.filter((d) => d.plan !== null).map((d) => `Your plan on ${d.name} stops now, with no refund for the rest of the month.`),
  ...preview.deletes.filter((d) => (d.creditsCents ?? 0) > 0).map((d) => `${dollars(d.creditsCents ?? 0)} of credits left on ${d.name} will be lost.`),
  ...(preview.deletes.some((d) => d.refundable === true) ? ["Bought some in the last 14 days? Write to support@fleetd.dev for a refund before you delete."] : []),
  ...(preview.deletes.length === 0 ? [] : ["Download your invoices from Manage billing first: after this only support can send them."]),
  "Your sign-in and its history are erased. Billing records the law requires are kept.",
];

/** Cents as dollars: $4.96. */
const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

/** Why the delete can't go ahead yet, and what to do; null when nothing holds it back. */
export const blockedLine = (preview: AccountPreview): string | null =>
  preview.blocked.length === 0
    ? null
    : `You're the only owner of ${list(preview.blocked)}, which ${preview.blocked.length === 1 ? "has" : "have"} other members. Make someone else an owner there, or delete the workspace, then delete your account.`;

/** The account's email typed back, as the cloud compares it (trimmed, any case): only then may Delete be pressed. */
export const emailMatches = (typed: string, email: string): boolean => typed.trim() !== "" && typed.trim().toLowerCase() === email.trim().toLowerCase();
