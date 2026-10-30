/** "a, b and c". */
export const listWords = (words: ReadonlyArray<string>): string =>
  words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1] ?? ""}`;

/** A day, as "Oct 27". */
export const dayWords = (iso: string, timeZone?: string): string =>
  new Date(iso).toLocaleDateString("en", { month: "short", day: "numeric", ...(timeZone === undefined ? {} : { timeZone }) });
