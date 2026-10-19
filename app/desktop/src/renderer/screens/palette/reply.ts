// The palette's reply mode: a terse inbox reply such as "1 go 2 nvm 3 b". The hub owns the grammar
// (crates/fleetd/src/hub/ledger/grammar.rs) and answers with an echo or a hint, so the app never interprets the
// verbs; it only decides that the text is a reply and which numbered items it names.

/** Text that can only be a reply: a leading item number, "#B<n>", "recs", "all <verb>", "pref:" or "forget D<n>". */
export const isReply = (text: string): boolean => /^\s*(?:\d|#B\d|recs\b|all\s+\S|pref:|forget\s+D\d)/iu.test(text);

/**
 * The item numbers the reply names, in order, without repeats: "1 go 2-4 nvm 6,7 b" → [1, 2, 3, 4, 6, 7]. Text
 * inside quotes or after a ":" is the person's own answer, not a selector.
 */
export const namedItems = (text: string): number[] => {
  const out: number[] = [];
  const add = (n: number) => {
    if (n >= 1 && n <= 999 && !out.includes(n)) out.push(n);
  };
  // Drop free-text answers first so "2: use port 8080" doesn't name item 8080.
  const bare = text.replace(/"[^"]*"?|'[^']*'?/gu, " ").replace(/:[^;\n]*/gu, " ");
  for (const match of bare.matchAll(/(?:^|[\s;,])(\d+)(?:-(\d+))?(?=[\s;,]|$|[a-z])/giu)) {
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    for (let n = from; n <= Math.min(to, from + 20); n += 1) add(n);
  }
  return out;
};

export interface ReplyResult {
  readonly ok: boolean;
  /** The hub's echo ("Logged: 1 → go (D12), 2 → dropped") or how to fix the reply. */
  readonly text: string;
}

/** Reads an inbox_reply call's outcome. Its output shape is fleetd_contracts::mcp::InboxReplyOutput. */
export const readReplyOutcome = (
  outcome: { readonly ok: true; readonly output: unknown } | { readonly ok: false; readonly error: { readonly message: string; readonly fix?: string } },
): ReplyResult => {
  if (!outcome.ok) {
    const { message, fix } = outcome.error;
    return { ok: false, text: fix === undefined ? message : `${message} ${fix}` };
  }
  const output = outcome.output;
  const field = (key: string): unknown => (typeof output === "object" && output !== null ? (output as Record<string, unknown>)[key] : undefined);
  const parsed = field("parsed") === true;
  const echo = field("echo");
  const hint = field("hint");
  if (parsed) return { ok: true, text: typeof echo === "string" && echo !== "" ? echo : "Done." };
  return { ok: false, text: typeof hint === "string" && hint !== "" ? hint : "The hub couldn't read that reply." };
};
