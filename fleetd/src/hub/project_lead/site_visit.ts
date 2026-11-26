// What a project's prompt visits, for its site gate: its lead's first fetch
// (`WebFetch`) or browser visit (`agent-browser open|goto|navigate|read <url>`) to a site asks the person, and their
// approval allows the site from then on. Any other shell command runs unasked (D208, D311). Commands joined with
// `&&`, `||`, `;`, `|` or a new line are read part by part, so `agent-browser open <url> && agent-browser snapshot`
// visits that one site and asks once. The site itself is sites.ts's.
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

/** Whether any word of `command` is one of the browser's OPENS. */
const namesAnOpen = (command: string) => command.split(/[^A-Za-z0-9-]/).some((w) => OPENS.includes(w));

const literal = (c: string) => /^[A-Za-z0-9]$/.test(c) || PLAIN_CHARS.includes(c);

/** A redirection the gate reads past: output to the terminal's other stream or thrown away. */
const REDIRECT = /^(?:[12]?>&[12]|[12]?>\s*\/dev\/null)(?=[\s;|&]|$)/u;

/**
 * `command` as plain commands, each its words as written (quotes kept): split at `&&`, `||`, `;`, `|` and new lines
 * outside quotes, with `2>&1` and `>/dev/null` left out. Undefined when a shell could read more into it: a `$`,
 * backquote, bracket, other redirection or background `&` outside single quotes, or a quote left open.
 */
export function plainCommands(command: string): string[][] | undefined {
  const out: string[][] = [[]];
  let word = "";
  const endWord = () => {
    if (word !== "") out[out.length - 1]!.push(word);
    word = "";
  };
  const endPart = () => {
    endWord();
    if (out[out.length - 1]!.length > 0) out.push([]);
  };
  let i = 0;
  while (i < command.length) {
    const c = command[i]!;
    if (c === "'" || c === '"') {
      const close = command.indexOf(c, i + 1);
      if (close < 0) return undefined;
      const inner = command.slice(i + 1, close);
      if (c === '"' && /[$`\\!]/u.test(inner)) return undefined;
      word += command.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    const redirect = word === "" || /^[12]$/u.test(word) ? REDIRECT.exec(command.slice(i)) : null;
    if (redirect) {
      word = "";
      i += redirect[0].length;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      endPart();
      i += 2;
      continue;
    }
    if (c === ";" || c === "|" || c === "\n") {
      endPart();
      i += 1;
      continue;
    }
    if (/[$`()<>&{}\\\r]/u.test(c)) return undefined;
    if (c === " " || c === "\t") endWord();
    else word += c;
    i += 1;
  }
  endWord();
  return out.filter((p) => p.length > 0);
}

/** A word's text without its quotes, when it is a plain word or one whole quoted literal; undefined otherwise. */
function unquoted(word: string): string | undefined {
  const q = word[0];
  if ((q === "'" || q === '"') && word.length >= 2 && word.endsWith(q)) {
    const inner = word.slice(1, -1);
    return inner.includes(q) ? undefined : inner;
  }
  return [...word].every(literal) ? word : undefined;
}

/** What one plain browser command visits: undefined for one that visits nothing (a click, a snapshot, its help). */
function browserVisit(words: string[]): Visit | undefined {
  const all = words.slice(1);
  // A flag beyond --json changes which browser runs or how; its value may stand where the verb would.
  const flagged = all.filter((w) => w.startsWith("-")).some((w) => !VISIT_FLAGS.includes(w.split("=")[0]!));
  if (flagged && all.some((w) => OPENS.includes(w))) return null;
  const rest = all.filter((w) => !w.startsWith("-"));
  if (!OPENS.includes(rest[0] ?? "")) return undefined;
  // One plain URL, or one whole quoted literal, and nothing else; every other word plain.
  if (rest.length !== 2 || !words.filter((w) => w !== rest[1]).every((w) => [...w].every(literal))) return null;
  const url = unquoted(rest[1]!);
  if (url === undefined || !plain(url)) return null;
  return siteOf(url) ?? null;
}

/**
 * What a prompt for `tool` with `input` visits; undefined when it isn't a fetch or a browser visit. A command whose
 * parts open two sites, or one the gate can't read whole with an open in it, is a visit asked each time.
 */
export function visit(tool: string, input: unknown): Visit | undefined {
  const field = (k: string) => (input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>)[k] : undefined);
  if (tool === "WebFetch") {
    const u = field("url");
    return siteOf(typeof u === "string" ? u : "") ?? null;
  }
  if (tool !== "Bash") return undefined;
  const raw = field("command");
  if (typeof raw !== "string") return undefined;
  const command = raw.trim();
  if (!command.includes("agent-browser")) return undefined;
  const parts = plainCommands(command);
  if (parts === undefined) return namesAnOpen(command) ? null : undefined;
  const sites = new Set<Visit>();
  for (const words of parts) {
    if (words[0] !== "agent-browser") {
      // The browser run another way (`npx agent-browser open …`, `timeout 30 agent-browser …`) isn't read.
      if (words.some((w) => w.includes("agent-browser")) && namesAnOpen(words.join(" "))) return null;
      continue;
    }
    const v = browserVisit(words);
    if (v !== undefined) sites.add(v);
  }
  if (sites.size === 0) return undefined;
  return sites.size === 1 ? [...sites][0]! : null;
}
