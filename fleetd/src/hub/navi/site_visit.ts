// What a Navi's prompt visits, for its site gate: its lead's first fetch
// (`WebFetch`) or browser visit (`agent-browser open|goto|navigate|read <url>`) to a site asks the person, and their
// approval allows the site from then on. Any other shell command runs unasked (D208). The site itself is sites.ts's.
import { siteOf } from "./sites.ts";

/** Its host without a leading `www.`; null for a fetch or visit whose site can't be read, asked each time. */
export type Visit = string | null;

/** The browser commands that go to a URL. */
const OPENS = ["open", "goto", "navigate", "read"];

/** The characters a remembered visit's command may hold besides letters, digits and spaces. */
const PLAIN_CHARS = "@._:/=-%+,";

/** The only flag a remembered visit may carry; any other changes which browser runs or how. */
const VISIT_FLAGS = ["--json"];

/** The characters a URL the gate reads may hold: a URL's own (RFC 3986). */
const plain = (url: string) => url !== "" && [...url].every((c) => /[\p{L}\p{N}]/u.test(c) || "-._~:/?#[]@!$&'()*+,;=%".includes(c));

/** Whether a shell could read `command` as more than one plain command. */
const compound = (command: string) => /[;&|$`()<>\n\r]/.test(command);

/** Whether any word of `command` is one of the browser's OPENS. */
const namesAnOpen = (command: string) => command.split(/[^A-Za-z0-9-]/).some((w) => OPENS.includes(w));

const literal = (c: string) => /^[A-Za-z0-9]$/.test(c) || PLAIN_CHARS.includes(c);

/**
 * What a prompt for `tool` with `input` visits; undefined when it isn't a fetch or a browser visit. An agent-browser
 * open anywhere in a command the gate can't read whole is a visit asked each time.
 */
export function visit(tool: string, input: unknown): Visit | undefined {
  const field = (k: string) => (input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>)[k] : undefined);
  let url: string;
  if (tool === "WebFetch") {
    const u = field("url");
    url = typeof u === "string" ? u : "";
  } else if (tool === "Bash") {
    const raw = field("command");
    if (typeof raw !== "string") return undefined;
    const command = raw.trim();
    if (!command.includes("agent-browser")) return undefined;
    const words = command.split(" ").filter((w) => w !== "");
    if (words[0] !== "agent-browser") return namesAnOpen(command) ? null : undefined;
    const all = words.slice(1);
    // A flag beyond --json changes which browser runs or how; its value may stand where the verb would.
    const flagged = all.filter((w) => w.startsWith("-")).some((w) => !VISIT_FLAGS.includes(w.split("=")[0]!));
    if (flagged && all.some((w) => OPENS.includes(w))) return null;
    const rest = all.filter((w) => !w.startsWith("-"));
    if (!OPENS.includes(rest[0] ?? "")) {
      // Another browser command (a click, a snapshot), unless a second command after it opens a site.
      return compound(command) && namesAnOpen(command) ? null : undefined;
    }
    // One plain URL, or one whole single-quoted literal, and nothing else.
    const arg = rest[1] ?? "";
    const inner = arg.length >= 2 && arg.startsWith("'") && arg.endsWith("'") ? arg.slice(1, -1) : undefined;
    const quoted = inner !== undefined && !inner.includes("'") ? inner : undefined;
    const before = command.endsWith(arg) ? command.slice(0, command.length - arg.length) : command;
    if (rest.length > 2 || ![...before].every((c) => c === " " || literal(c)) || (quoted === undefined && ![...arg].every(literal))) return null;
    url = quoted ?? arg;
    if (!plain(url)) return null;
  } else {
    return undefined;
  }
  return siteOf(url) ?? null;
}
