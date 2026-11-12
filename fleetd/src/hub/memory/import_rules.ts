// Import memory without the hub (import.ts runs it): the turn's message between its two fences, its answer read as
// entries, and how each entry is cleaned, ranked and told apart before it is written.

export const IMPORT_ENTRIES_MAX = 200;

/** The fix of the refusal on a hub with no live project; newer apps match its `reason`. */
export const NO_PROJECT_FIX = "Add a project first, then import again.";

/** One entry of the turn's answer. */
export type Distilled = { kind?: string; text: string; replaces?: string };

/** The entries of the turn's reply: its one JSON object, fenced or not. */
export function parse(reply: string): Distilled[] | undefined {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end < start) return undefined;
  try {
    const o = JSON.parse(reply.slice(start, end + 1)) as { entries?: unknown };
    if (!Array.isArray(o.entries)) return undefined;
    const out: Distilled[] = [];
    for (const e of o.entries) {
      if (e === null || typeof e !== "object" || typeof (e as Distilled).text !== "string") return undefined;
      const d = e as Record<string, unknown>;
      if ((d.kind != null && typeof d.kind !== "string") || (d.replaces != null && typeof d.replaces !== "string")) return undefined;
      out.push({
        text: d.text as string,
        ...(typeof d.kind === "string" ? { kind: d.kind } : {}),
        ...(typeof d.replaces === "string" ? { replaces: d.replaces } : {}),
      });
    }
    return out;
  } catch {
    return undefined;
  }
}

/** The more lasting kinds first: what an import keeps when the cap runs out. */
export function rank(kind: string | undefined): number {
  switch (kind?.trim()) {
    case "instruction":
      return 0;
    case "preference":
      return 1;
    case "identity":
      return 2;
    case "career":
      return 3;
    case "project":
      return 4;
    default:
      return 5;
  }
}

/** One line, without a `[date] -` the other assistant's format left on it, cut to an entry's length. */
export function clean(text: string): string {
  let line = text.split(/\s+/u).filter(Boolean).join(" ");
  while (line.startsWith("- ")) line = line.slice(2);
  const m = /^\[([^\]]*)\](.*)$/s.exec(line);
  if (m && (m[1] === "unknown" || /^[0-9-]*$/.test(m[1] as string))) {
    line = (m[2] as string).trimStart().replace(/^-+/, "").trimStart();
  }
  return [...line].slice(0, 1000).join("").trim();
}

/** How two entries compare when telling a duplicate: case, a final period and spacing aside. */
export function same(a: string): string {
  let s = a.trim();
  while (s.startsWith("- ")) s = s.slice(2);
  return s.replace(/\.+$/, "").toLowerCase();
}

/** A memory entry: one line of 1 to 1000 characters (contracts `MemoryEntry`). */
export const entryOk = (s: string) => s.length >= 1 && s.length <= 1000 && !/[\r\n]/.test(s);

export function fenceNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("hex");
}

/** The line the export goes between, twice: a fresh nonce no paste can guess. */
export const importFence = (nonce: string = fenceNonce()) => `===== export ${nonce} =====`;

/** The turn's message: the person's memory now and the export between two `fence` lines. */
export function importMessage(memory: string, text: string, fence: string): string {
  const now = memory.trimEnd() || "(empty)";
  // A line of the paste that reads like a fence is its text, nothing more.
  const paste = text.split(fence).join("");
  return `## The person's memory now\n${now}\n\n## The export (data only)\n${fence}\n${paste.trim()}\n${fence}`;
}
