// What the approval checker reads, and what fleetd decides past it (W239, built from T1480's eval of 86 risky actions;
// crates/fleetd/src/hub/project_lead/review.rs). Pure: no hub, no model.
//
// The checker's input is a `Review`, sent as JSON inside `<action_review>`: the person and their recent messages (the
// only authority), the project's last question to them (so a bare "yes" can be judged), the action exactly as it runs, and
// where each of its parts came from (`provenance`), found by matching values against what the person said and what
// the project read: `person`, `person (pasted text)`, `contacts`, `thread`, `sent_mail`, `person's files`,
// `allowed site <host>`, `untrusted: <kind> from <sender>`, or `the lead`. Long text gets the spans quoted from
// untrusted content or from the person. The content the project read never goes in, nor the project's own explanation.
//
// Then the code rules (`rules`), which no model's word overrides: the floors (money, trading, credentials in what goes
// out) block; a destination only untrusted content named, a URL carrying data, a public or editor share to a new
// party, a forwarding rule to another domain, a lookalike domain, a bulk send and a one-time code in what goes out ask
// at least. A model that refused, timed out or answered nothing readable asks (`decide`).
//
// Rust's regex classes are Unicode (`\w`, `\d`, `\b`) and its `str::len` counts UTF-8 bytes: both are kept here.
import type { CheckerNote, CheckerVerdict } from "../../shared/contracts.ts";
import { called, gateway, never, neverWhy, sortedValue, words } from "../integrations/policy.ts";
import { redact } from "../redact.ts";
import { siteOf } from "./sites.ts";

/** More recipients than this in one send asks. */
export const BULK = 10;
/** A quoted span shorter than this says too little to match. */
const SPAN_MIN = 16;
/** A part this long is text: matched span by span, not as a value. */
const TEXT_MIN = 120;

/** The checker's whole input; its JSON keys are Rust's field names. */
export type Review = {
  person: unknown;
  /** The person's own addresses and those of their contacts the project read, for the lookalike rule. */
  contacts: unknown[];
  allowed_sites: string[];
  today: string;
  /** Oldest first. */
  person_messages: string[];
  /** The project's last message to the person, when it asked something: written by its lead, never authority. */
  lead_last_question?: string;
  /** The automations whose runs the project is doing now and whose prompt the person wrote or said yes to. */
  standing_requests: Standing[];
  action: unknown;
  provenance: Provenance[];
};

/** Where one part of the action came from. */
export type Provenance = {
  /** `to[0]`, `body`, `url.host`. */
  part: string;
  sources: string[];
  value?: string;
  quoted_from_untrusted: string[];
  from_person: string[];
};

/** An automation the person wrote or said yes to, whose run the project is doing: its name and its prompt. */
export type Standing = { automation: string; prompt: string };

/** Content the project read: one tool call's output, with the call (`WebFetch https://…`). */
export type Read = { source: string; text: string };

const prov = (part: string, sources: string[], value?: string, quoted: string[] = [], said: string[] = []): Provenance => ({
  part,
  sources,
  ...(value !== undefined ? { value } : {}),
  quoted_from_untrusted: quoted,
  from_person: said,
});

/** The review as serde writes it: struct fields in order, empty and absent optional fields left out, maps sorted. */
function serialized(r: Review): unknown {
  return {
    person: sortedValue(r.person),
    contacts: r.contacts.map(sortedValue),
    allowed_sites: r.allowed_sites,
    today: r.today,
    person_messages: r.person_messages,
    ...(r.lead_last_question !== undefined ? { lead_last_question: r.lead_last_question } : {}),
    ...(r.standing_requests.length > 0 ? { standing_requests: r.standing_requests.map((s) => ({ automation: s.automation, prompt: s.prompt })) } : {}),
    action: sortedValue(r.action),
    provenance: r.provenance.map((p) => ({
      part: p.part,
      sources: p.sources,
      ...(p.value !== undefined ? { value: p.value } : {}),
      ...(p.quoted_from_untrusted.length > 0 ? { quoted_from_untrusted: p.quoted_from_untrusted } : {}),
      ...(p.from_person.length > 0 ? { from_person: p.from_person } : {}),
    })),
  };
}

/** The user turn: the review as JSON inside `<action_review>`, `<` and `>` escaped so nothing can close the tag. */
export function render(r: Review): string {
  const json = JSON.stringify(serialized(r), null, 2).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
  return `<action_review>\n${json}\n</action_review>`;
}

/** Its provenance label: `person (automation "Weekly report")`. */
const standingSource = (s: Standing) => `person (automation "${s.automation.replaceAll('"', "'")}")`;

// --- Text as Rust reads it ---------------------------------------------------------------------------------------

/** `str::len`: UTF-8 bytes. */
const bytes = (s: string) => Buffer.byteLength(s, "utf8");
/** `chars().count()`. */
const chars = (s: string) => [...s].length;
/** usage/time.rs `clip`: at most `max` characters, the last one `…` when cut. */
export function clip(text: string, max: number): string {
  const c = [...text];
  return c.length > max ? `${c.slice(0, Math.max(0, max - 1)).join("")}…` : text;
}
/** `str::lines`: split on `\n`, a trailing `\r` dropped, no last empty line after a final `\n`. */
export function lines(text: string): string[] {
  if (text === "") return [];
  const out = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (text.endsWith("\n")) out.pop();
  return out;
}
const splitWhitespace = (s: string) => s.split(/\s+/).filter(Boolean);
const norm = (text: string) => splitWhitespace(text).join(" ").toLowerCase();

/** Rust regex's Unicode `\w`. */
const W = String.raw`[\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}]`;
/** Rust regex's Unicode `\b`. */
const B = String.raw`(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/u;
/** A header line of a mail: `From: Sam <sam@example.org>`. */
const HEADER = /^\s*(from|to|cc|bcc|reply-to|sender|organizer|attendees?)\s*:\s*([^\n]+)$/gimu;
const FROM_LINE = /^\s*(from|sender|organizer)\s*:\s*([^\n]+)$/imu;
/** Any header line: `Subject: Saturday`, `Message-ID: <…>`. */
const HEADER_LINE = new RegExp(String.raw`^\s*[A-Za-z](?:${W}|-){0,30}:(\s|$)`, "u");
/** A line between two mails of a plain-text list: `---`, `===`, `***`. */
const SEPARATOR = /^\s*([-=*#~─━]\s*){3,}$/u;
/** A line that starts quoted mail inside a message: `-----Original Message-----`, `On Monday, Sam wrote:`. */
const QUOTE_START = new RegExp(
  String.raw`^\s*(-+\s*(original|forwarded) message\s*-*|begin forwarded message:?|_{5,}|.*${B}wrote:)\s*$`,
  "iu",
);
/** A long base64 or hex blob in a URL: data, not an address. */
const BLOB = /[A-Za-z0-9+/_=]{32,}|[0-9a-fA-F]{32,}/g;
/** An encoded blob in a message: data hidden from the person. */
const ENCODED = /[A-Za-z0-9+/]{40,}={0,2}/;
const SECRET = new RegExp(
  String.raw`${B}(password|passwd|passcode|passphrase|pin|api[ _-]?key|secret key|private key)${B}\s*(is|:|=)\s*\S{4,}`,
  "iu",
);
const ONE_TIME_CODE = new RegExp(String.raw`${B}(code|otp|verification|2fa|one-time)${B}\P{Nd}{0,24}${B}\p{Nd}{4,8}${B}`, "iu");
/** An ACTING_AS key's value in a read's call: `"account":"sam@example.org"`, at any depth, in a cut call too. */
const ACCOUNT_IN_CALL = /"([A-Za-z_]+)"\s*:\s*"([^"]+)"/g;

/**
 * Whether `text` holds an encoded blob: 32 or more hex digits, or a run of 32 or more base64 characters mixing upper
 * and lower case and digits. A path or a slug (`/markets/stock-market-today`) isn't one.
 */
function blob(text: string): boolean {
  for (const m of text.matchAll(BLOB)) {
    const t = m[0];
    if (/^[0-9a-fA-F]+$/.test(t) || (/[A-Z]/.test(t) && /[a-z]/.test(t) && /[0-9]/.test(t))) return true;
  }
  return false;
}

const emailRe = () => new RegExp(EMAIL.source, "g");
const isEmail = (s: string) => new RegExp(EMAIL.source).test(s);

function emails(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(emailRe())) {
    const e = m[0].replace(/\.+$/, "").toLowerCase();
    if (!out.includes(e)) out.push(e);
  }
  return out;
}

/** Every string in `v`, with where it is: `to[0]`, `message.body`; object keys sorted, as serde_json holds them. */
export function leaves(v: unknown): [string, string][] {
  const out: [string, string][] = [];
  const walk = (v: unknown, at: string) => {
    if (typeof v === "string") out.push([at, v]);
    else if (Array.isArray(v)) v.forEach((item, i) => walk(item, `${at}[${i}]`));
    else if (v !== null && typeof v === "object") {
      const o = v as Record<string, unknown>;
      for (const k of Object.keys(o).sort()) walk(o[k], at === "" ? k : `${at}.${k}`);
    }
  };
  walk(v, "");
  return out;
}

/** `url::form_urlencoded::parse`: `&`-separated pairs, `+` a space, percent-decoded, invalid UTF-8 replaced. */
export function formParse(input: string): [string, string][] {
  const decode = (s: string) => {
    const raw = Buffer.from(s.replaceAll("+", " "), "utf8");
    const out: number[] = [];
    for (let i = 0; i < raw.length; i++) {
      const hex = (b: number | undefined) => b !== undefined && /[0-9a-fA-F]/.test(String.fromCharCode(b));
      if (raw[i] === 0x25 && hex(raw[i + 1]) && hex(raw[i + 2])) {
        out.push(parseInt(String.fromCharCode(raw[i + 1]!, raw[i + 2]!), 16));
        i += 2;
      } else out.push(raw[i]!);
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(Uint8Array.from(out));
  };
  const pairs: [string, string][] = [];
  for (const piece of input.split("&")) {
    if (piece === "") continue;
    const at = piece.indexOf("=");
    pairs.push(at < 0 ? [decode(piece), ""] : [decode(piece.slice(0, at)), decode(piece.slice(at + 1))]);
  }
  return pairs;
}

/** A URL as the `url` crate reads it: undefined where it can't parse. */
type Parsed = { url: URL; host: { domain: string } | { ip: string } | undefined; query?: string; fragment?: string };
function parse(text: string): Parsed | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  const [beforeHash, ...afterHash] = url.href.split("#");
  const h = url.hostname;
  const host = h === "" ? undefined : h.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(h) ? { ip: h } : { domain: h };
  return {
    url,
    host,
    ...(beforeHash!.includes("?") ? { query: url.search.slice(1) } : {}),
    ...(afterHash.length > 0 ? { fragment: afterHash.join("#") } : {}),
  };
}

// --- What a read is ----------------------------------------------------------------------------------------------

type Kind = "contacts" | "calendar" | "sent" | "mail" | "web" | "file" | "chat_file" | "other";

/**
 * What a read is, by its tool's name alone: never by its input (a search for "-in:sent" is no sent folder), but for a
 * file sent in the chat, which any tool's input naming its folder reads. A gateway's call (`call_read_tool`) is the
 * tool it called, by the name in its input; one whose call was cut too short to say is anyone's content.
 */
function kind(source: string): Kind {
  const at = source.indexOf(" ");
  const tool = at < 0 ? source : source.slice(0, at);
  const input = at < 0 ? "" : source.slice(at + 1);
  // Whatever tool read it, a chat file is what it is: never the person's own files.
  if (input.includes(".fleetd/attachments/")) return "chat_file";
  let w = words(tool);
  if (gateway(tool)) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(input);
    } catch {}
    const c = called(tool, parsed);
    if (c === undefined) return "other";
    w = words(c);
  }
  const has = (list: string[]) => w.some((x) => list.includes(x));
  if (has(["contact", "contacts", "people", "directory"])) return "contacts";
  if (has(["calendar", "calendars", "event", "events"])) return "calendar";
  if (has(["mail", "gmail", "email", "emails", "message", "messages", "thread", "threads", "inbox", "outlook"])) {
    return w.includes("sent") ? "sent" : "mail";
  }
  if (has(["webfetch", "websearch", "browser", "fetch", "http", "https"])) return "web";
  if (has(["read", "glob", "grep", "file", "files", "drive", "doc", "docs", "notes"])) return "file";
  return "other";
}

/** Keys that name who or where an action reaches. */
const DESTINATIONS = [
  "to", "cc", "bcc", "recipient", "recipients", "attendees", "invitees", "guests", "with", "share_with", "emailaddress",
  "email_address", "emails", "forward_to", "forwardto", "forward", "members", "users", "host",
];
/** Keys that can name which of the person's own accounts a tool acts as. On a send or an invite they may name whom it reaches. */
const ACTING_AS = ["account", "account_id", "accountid", "mailbox", "user_id", "userid"];
/** The source of an ACTING_AS value the project already read the person's data as. It vouches for no recipient. */
const ACCOUNT = "an account the lead read the person's data as";
/** The source of what the lead wrote itself, as the checker and a card name it. */
const LEAD = "the lead";
/** Keys of ACTING_AS that only ever pick the account a tool acts as, on a send too: its sender. */
const SENDER = ["account", "account_id", "accountid", "mailbox"];

/** What the project read, sorted into the person's own data (each value with its source) and untrusted text. */
class Sources {
  /** Lower-case values and the source they name. */
  readonly own: [string, string][] = [];
  /** Lower-case, whitespace-folded text that anyone could have written, with its label. */
  readonly untrusted: [string, string][] = [];
  readonly said: string[] = [];
  readonly pasted: string[] = [];
  readonly standing: [string, string][];
  readonly accounts: string[];

  constructor(person: string[], standing: Standing[], reads: Read[], personEmails: string[]) {
    for (const m of person) {
      let fenced = false;
      for (const line of lines(m)) {
        const t = line.trimStart();
        if (t.startsWith("```")) {
          fenced = !fenced;
          continue;
        }
        if (fenced || t.startsWith(">")) this.pasted.push(norm(t.replace(/^>+/, "")));
        else this.said.push(norm(line));
      }
    }
    for (const e of personEmails) this.own.push([e, "person's own address"]);
    for (const r of reads) {
      const k = kind(r.source);
      // Anyone can send an invite: its attendees are no one the person chose.
      const headerSource = k === "contacts" ? "contacts" : k === "sent" ? "sent_mail" : k === "mail" ? "thread" : undefined;
      if (k === "contacts") {
        for (const e of emails(r.text)) this.own.push([e, "contacts"]);
        continue;
      }
      if (headerSource !== undefined) for (const e of headerAddresses(r.text)) this.own.push([e, headerSource]);
      if (k === "file") {
        for (const l of lines(r.text).map((l) => l.trim())) {
          if (l !== "" && bytes(l) < 300) this.own.push([norm(l), "person's files"]);
        }
      }
      this.untrusted.push([norm(r.text), label(k, r)]);
    }
    const accounts: string[] = [];
    for (const r of reads) {
      for (const c of r.source.matchAll(ACCOUNT_IN_CALL)) if (ACTING_AS.includes(c[1]!)) accounts.push(c[2]!.toLowerCase());
    }
    this.accounts = [...new Set(accounts)].sort();
    this.standing = standing.map((s) => [norm(s.prompt), standingSource(s)]);
  }

  /** Every source of a short value: the person first, then their own data, then untrusted content; the lead when none. */
  of(value: string): string[] {
    const v = norm(value);
    const out: string[] = [];
    const add = (s: string) => {
      if (!out.includes(s)) out.push(s);
    };
    if (v === "") return [LEAD];
    if (this.said.some((m) => m.includes(v))) add("person");
    if (this.pasted.some((m) => m.includes(v))) add("person (pasted text)");
    for (const [prompt, source] of this.standing) if (prompt.includes(v)) add(source);
    for (const [own, source] of this.own) {
      if (own === v || (bytes(v) >= 6 && own.includes(v) && source === "person's files")) add(source);
    }
    const aFile = out.includes("person's files");
    for (const [text, lbl] of this.untrusted) {
      // A file's own name in a listing is the person's file, not something a file said.
      if (text.includes(v) && !(aFile && lbl === "a file")) add(`untrusted: ${lbl}`);
    }
    if (out.length === 0) out.push(LEAD);
    return out;
  }

  /** The spans of `text` (its sentences and lines) that untrusted content holds, and those the person said. */
  spans(text: string): [string[], string[]] {
    const quoted: string[] = [];
    const said: string[] = [];
    for (const span of text.split(/[\n.!?]/).map((s) => s.trim())) {
      if (chars(span) < SPAN_MIN) continue;
      const n = norm(span);
      if ([...this.said, ...this.pasted, ...this.standing.map(([p]) => p)].some((m) => m.includes(n))) said.push(clip(span, 300));
      else if (this.untrusted.some(([t]) => t.includes(n))) quoted.push(clip(span, 300));
    }
    return [quoted, said];
  }
}

/**
 * The header blocks of a plain-text read, one per mail. A mail starts at the top and after each separator line
 * (`---`), and its first paragraph is its headers; in a list with only blank lines between mails, a later paragraph
 * made only of header lines, one of them a `From:`, starts another. Nothing past the start of a quote counts, to the
 * end of the read. A line quoted with `>` is no header line.
 */
function heads(text: string): string[] {
  const out: string[] = [];
  let block: string[] = [];
  let first = true;
  const flush = () => {
    if (block.length === 0) return;
    const head = block.join("\n");
    const allHeaders = block.every((l) => HEADER_LINE.test(l) || l.startsWith(" ") || l.startsWith("\t"));
    if (first || (allHeaders && FROM_LINE.test(head))) out.push(head);
    first = false;
    block = [];
  };
  for (const line of lines(text)) {
    if (SEPARATOR.test(line)) {
      flush();
      first = true;
    } else if (line.trim() === "") flush();
    else if (!HEADER_LINE.test(line) && QUOTE_START.test(line)) return out;
    else block.push(line);
  }
  flush();
  return out;
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** The addresses in a mail's or an event's headers: the header lines of each of its mails, and the address keys of its JSON. */
function headerAddresses(text: string): string[] {
  const out: string[] = [];
  for (const head of heads(text)) for (const c of head.matchAll(HEADER)) out.push(...emails(c[2]!));
  const v = parseJson(text);
  if (v !== undefined) {
    const keys = ["from", "to", "cc", "bcc", "reply_to", "replyto", "sender", "organizer", "attendees", "email", "address", "participants"];
    for (const [at, value] of leaves(v)) {
      const k = (at.split(".").at(-1) ?? at).split("[")[0]!.toLowerCase();
      if (keys.includes(k)) out.push(...emails(value));
    }
  }
  return [...new Set(out)].sort();
}

/** `an email from sam@example.org`, `a web page on example.org`. */
function label(k: Kind, r: Read): string {
  let sender: string | undefined;
  const c = FROM_LINE.exec(r.text);
  if (c) sender = emails(c[2]!)[0];
  if (sender === undefined) {
    const v = parseJson(r.text);
    if (v !== undefined) {
      const found = leaves(v).find(([at]) => at.endsWith("from") || at.endsWith("sender") || at.endsWith("organizer"));
      if (found) sender = emails(found[1])[0];
    }
  }
  const from = sender !== undefined ? ` from ${sender}` : "";
  switch (k) {
    case "mail":
    case "sent":
      return `an email${from}`;
    case "calendar":
      return `a calendar invite${from}`;
    case "web": {
      const u = URL_RE.exec(r.source);
      const site = u ? siteOf(u[0]) : undefined;
      return site !== undefined ? `a web page on ${site}` : "a web page";
    }
    case "file":
      return "a file";
    case "chat_file":
      return "a file sent in the chat";
    default:
      return "content the lead read";
  }
}

/** The name a part's key ends in: `to` for `to[0]`, `body` for `message.body`. */
function key(part: string): string {
  return (part.split(".").at(-1) ?? part).split("[")[0]!.toLowerCase();
}

/**
 * The person's own addresses (the sender of each of their sent mails) and the addresses of their contacts (a contact
 * list, their sent mail) in what the project read. Nothing the action itself says counts, nor a thread's or an invite's.
 */
export function known(person: string[], reads: Read[]): [string[], string[]] {
  const mine: string[] = [];
  for (const r of reads.filter((r) => kind(r.source) === "sent")) {
    // Each sent mail's own sender, never one in a quote of the mail it answered.
    for (const head of heads(r.text)) {
      const c = FROM_LINE.exec(head);
      if (c) mine.push(...emails(c[2]!));
    }
    const v = parseJson(r.text);
    if (v !== undefined) for (const [at, value] of leaves(v)) if (key(at) === "from") mine.push(...emails(value));
  }
  const own = [...new Set(mine)].sort();
  const sources = new Sources(person, [], reads, own);
  const contacts = [
    ...new Set(
      sources.own
        .filter(([v, s]) => ["contacts", "sent_mail", "person's own address"].includes(s) && isEmail(v))
        .map(([v]) => v),
    ),
  ]
    .sort()
    .slice(0, 500);
  return [own, contacts];
}

/** The action's provenance: each field of its input (a short value by its value, text span by span), and a visit's URL. */
export function provenance(
  input: unknown,
  url: string | undefined,
  person: string[],
  standing: Standing[],
  reads: Read[],
  allowed: string[],
): Provenance[] {
  const sources = new Sources(person, standing, reads, known(person, reads)[0]);
  const out: Provenance[] = [];
  const parsed = url !== undefined ? parse(url) : undefined;
  if (url !== undefined && parsed) {
    const host = parsed.url.hostname.toLowerCase();
    const site = siteOf(url) ?? host;
    let from = sources.of(url);
    if (from.length === 1 && from[0] === LEAD) from = sources.of(host);
    if (allowed.includes(site)) from = [`allowed site ${site}`, ...from.filter((s) => s !== LEAD)];
    out.push(prov("url.host", from, host));
    const rest = `${parsed.url.pathname}${parsed.query !== undefined ? `?${parsed.query}` : ""}`;
    if (bytes(rest) > 1) {
      const decoded = formParse(rest.replaceAll("?", "&"))
        .map(([k, v]) => `${k} ${v}`)
        .join("\n");
      const [quoted, said] = sources.spans(decoded.replace(/[&=]/g, "\n"));
      const of = sources.of(rest);
      out.push(prov("url.path_and_query", of.length === 1 && of[0] === LEAD ? [LEAD] : of, clip(rest, 500), quoted, said));
    }
  }
  for (const [at, text] of leaves(input)) {
    if (text.trim() === "" || (url !== undefined && URL_RE.test(text) && text.includes(url))) continue;
    const firstEmail = new RegExp(EMAIL.source).exec(text);
    if (chars(text) < TEXT_MIN || (firstEmail !== null && bytes(firstEmail[0]) + 40 > bytes(text))) {
      const from = sources.of(text);
      if (ACTING_AS.includes(key(at)) && sources.accounts.includes(text.trim().toLowerCase())) from.push(ACCOUNT);
      out.push(prov(at, from, text));
      continue;
    }
    const whole = sources.of(text);
    const [quoted, said] = sources.spans(text);
    out.push(prov(at, whole.some((s) => s.startsWith("person")) ? whole : [LEAD], undefined, quoted, said));
    // An address inside a text is a part of its own.
    for (const e of emails(text)) out.push(prov(`address in ${at}`, sources.of(e), e));
  }
  return out;
}

const field = (input: unknown, k: string): unknown =>
  input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>)[k] : undefined;
const str = (input: unknown, k: string): string | undefined => {
  const v = field(input, k);
  return typeof v === "string" ? v : undefined;
};

/** The URL of a visit: its `url`, or the one in its browser command. */
export function visitUrl(input: unknown): string | undefined {
  const u = str(input, "url");
  if (u !== undefined) return u;
  const command = str(input, "command");
  if (command === undefined) return undefined;
  const m = URL_RE.exec(command);
  return m ? m[0].replace(/'+$/, "") : undefined;
}

/** Whether `url` carries data: an email address, a long base64 or hex blob, or text quoted from what the project read. */
export function carriesData(url: string, quoted: string[]): boolean {
  const decoded = formParse(url.replaceAll("?", "&"))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return isEmail(`${decoded} ${url.replaceAll("%40", "@")}`) || blob(url) || quoted.length > 0;
}

/** A path part or fragment this long, found in what the person said or in their own data the project read, is data. */
const PATH_DATA_MIN = 8;

/**
 * Whether `url` is a plain public read (D286): an http or https link to a named public host (no IP address, no
 * loopback, no local or tailnet name) with no query, carrying no data by `carriesData`, and no part of its path or
 * fragment that the person's messages or their own data the project read hold.
 */
export function plainRead(url: string, person: string[], reads: Read[]): boolean {
  const parsed = parse(url);
  if (!parsed) return false;
  let isPublic = false;
  if (parsed.host && "domain" in parsed.host) {
    const host = parsed.host.domain.replace(/\.+$/, "").toLowerCase();
    isPublic = host.includes(".") && ![".local", ".localhost", ".internal", ".lan", ".home.arpa", ".ts.net"].some((end) => host.endsWith(end));
  }
  const path = parsed.url.pathname;
  if (
    (parsed.url.protocol !== "http:" && parsed.url.protocol !== "https:") ||
    !isPublic ||
    parsed.url.port !== "" ||
    parsed.query !== undefined ||
    carriesData(url, []) ||
    // A code in one part of the path, which a run across `/` can hide from `blob`.
    path.split("/").some(blob)
  ) {
    return false;
  }
  // Words only: a path's `-`, `_`, `+` and `.` read as the spaces they stand for.
  const wordsOf = (text: string) => norm(text.replace(/[-_+./&=]/g, " "));
  const priv = [
    ...person.map(wordsOf),
    ...reads.filter((r) => kind(r.source) !== "web" && !r.source.startsWith("WebSearch")).map((r) => wordsOf(r.text)),
  ];
  const decoded = (part: string) =>
    wordsOf(
      formParse(part)
        .map(([k, v]) => `${k} ${v}`)
        .join(" "),
    );
  // Each part of the path, the whole path (data split over its parts), and the fragment.
  const parts = path.split("/").map(decoded);
  parts.push(decoded(path));
  if (parsed.fragment !== undefined) parts.push(decoded(parsed.fragment));
  return !parts.some((p) => chars(p) >= PATH_DATA_MIN && priv.some((m) => m.includes(p)));
}

/**
 * Whether a part names whom or where the action reaches. An ACTING_AS key whose value the project already read the
 * person's data as picks the account the tool acts in, and reaches no one.
 */
function isDestination(p: Provenance, confirm: boolean, write: boolean): boolean {
  const k = key(p.part);
  if (ACTING_AS.includes(k) && (write || SENDER.includes(k)) && p.sources.includes(ACCOUNT)) return false;
  if (DESTINATIONS.includes(k) || (confirm && p.part === "site") || p.part === "url") return true;
  if (p.value === undefined) return false;
  const v = p.value.trim();
  const m = new RegExp(EMAIL.source).exec(v);
  return m !== null && bytes(m[0]) === bytes(v) && !p.part.startsWith("address in");
}

/** Content anyone could have written, or a contact the project made from it. */
const untrusted = (source: string) => source.startsWith("untrusted") || source.includes("from an email");
/** A source of the person's own: anything but untrusted content and the project. */
const own = (source: string) => !untrusted(source) && source !== LEAD && source !== ACCOUNT;

/** The addresses an action reaches: each destination's value, and every address in a list part. */
function destinationEmails(review: Review): string[] {
  const out: string[] = [];
  for (const [at, v] of leaves(review.action)) {
    if (DESTINATIONS.includes(key(at))) for (const e of emails(v)) if (!out.includes(e)) out.push(e);
  }
  return out;
}

const domain = (email: string) => email.split("@").at(-1) ?? "";

function distance(a: string, b: string): number {
  const [x, y] = [[...a], [...b]];
  const row = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const cur = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (x[i - 1] !== y[j - 1] ? 1 : 0));
      prev = cur;
    }
  }
  return row[y.length]!;
}

/**
 * The floors, refused in every mode, YOLO's too: moving money or trading by the tool's name or by a link that performs
 * it (its path says transfer or trade and its query carries the amount), and what looks like a password, key or token
 * anywhere in what goes out, a link it opens included. Why, or undefined. `action` is the tool's input with its `tool`
 * (and `kind`) beside it.
 */
export function floor(action: unknown): string | undefined {
  const n = never(`${str(action, "tool") ?? ""} ${str(action, "kind") ?? ""}`);
  if (n !== undefined) return neverWhy(n);
  // A link that performs a transfer or a trade: its path says so and its query carries the amount.
  const u = visitUrl(action);
  const parsed = u !== undefined ? parse(u) : undefined;
  if (parsed) {
    const query = parsed.query ?? "";
    const amount = formParse(query).some(([k]) => ["amount", "amt", "sum", "value", "qty", "quantity", "shares", "units"].includes(k.toLowerCase()));
    const m = amount ? never(`${parsed.url.pathname} ${query}`) : undefined;
    if (m === "money" || m === "trading") return neverWhy(m);
  }
  const credential = leaves(action)
    .filter(([at]) => at !== "tool" && at !== "kind")
    .some(([, v]) => {
      const decoded = formParse(v)
        .map(([k, x]) => `${k}=${x} `)
        .join("");
      return [v, decoded].some((t) => SECRET.test(t) || redact(t) !== t);
    });
  return credential ? neverWhy("credential") : undefined;
}

/** What fleetd decides whatever the checker says: block for a floor, ask for a minimum ask, with why. */
export function rules(review: Review): CheckerNote | undefined {
  const tool = `${str(review.action, "tool") ?? ""} ${str(review.action, "kind") ?? ""}`;
  const url = visitUrl(review.action);
  const why = floor(review.action);
  if (why !== undefined) return note("block", why);
  const outgoing = leaves(review.action)
    .filter(([at]) => at !== "tool" && at !== "kind")
    .map(([, v]) => v);
  // A one-time code, or an encoded blob, in what goes out.
  if (outgoing.some((v) => ONE_TIME_CODE.test(v))) return ask("it sends what looks like a one-time code");
  if (url === undefined && outgoing.some((v) => ENCODED.test(v))) return ask("it sends an encoded blob nobody can read");
  // A destination only untrusted content named.
  const actionKind = str(review.action, "kind");
  const confirm = actionKind === "confirm_step";
  const write = actionKind === "write";
  for (const p of review.provenance.filter((p) => isDestination(p, confirm, write))) {
    if (p.sources.some(untrusted) && !p.sources.some(own)) {
      return ask(`${p.value ?? p.part} came only from content the lead read, not from you`);
    }
  }
  // A URL that carries data, even on an allowed site.
  if (url !== undefined) {
    const quoted = review.provenance.filter((p) => p.part.startsWith("url")).flatMap((p) => p.quoted_from_untrusted);
    if (carriesData(url, quoted)) return ask("the link carries data: an address, a long code or text from your mail");
  }
  // Shares.
  const fields = leaves(review.action);
  const fieldValues = (names: string[]) => fields.filter(([at]) => names.includes(key(at))).map(([, v]) => v.toLowerCase());
  if (
    fieldValues(["link_sharing", "visibility", "general_access", "access", "type", "scope"]).some((v) =>
      ["anyone", "anyone_with_link", "anyonewithlink", "public", "domain"].includes(v),
    )
  ) {
    return ask("it shares with anyone who has the link, or publicly");
  }
  const editor = fieldValues(["role", "permission", "access_level"]).some((v) =>
    ["editor", "writer", "owner", "organizer", "fileorganizer", "edit", "admin"].includes(v),
  );
  const contacts = contactEmails(review);
  const isKnown = (e: string) =>
    review.provenance.some(
      (p) =>
        p.value?.toLowerCase() === e &&
        p.sources.some((s) => (s.startsWith("contacts") && own(s)) || s === "thread" || s.startsWith("person")),
    ) || contacts.includes(e);
  const reached = destinationEmails(review);
  if (editor && reached.some((e) => !isKnown(e))) return ask("it gives edit access to someone new");
  // A forwarding rule or filter to another domain.
  const tw = words(tool);
  if (tw.some((w) => ["filter", "rule", "forward_rule", "autoforward", "forwarding"].includes(w)) || actionKind === "forward_rule") {
    const ownDomains = emails(JSON.stringify(sortedValue(review.person)) ?? "null").map(domain);
    if (reached.some((e) => !ownDomains.includes(domain(e)))) return ask("it sets a rule that forwards your mail to another address");
  }
  // A lookalike of a contact's domain.
  const contactDomains = contacts.map(domain);
  for (const e of reached) {
    const d = domain(e);
    if (!contactDomains.includes(d) && contactDomains.some((c) => [1, 2].includes(distance(c, d)))) {
      return ask(`${d} looks like one of your contacts' domains, but isn't`);
    }
  }
  if (reached.length > BULK) return ask(`it reaches ${reached.length} people at once`);
  return undefined;
}

const contactEmails = (review: Review) => review.contacts.flatMap((c) => emails(JSON.stringify(sortedValue(c)) ?? "null"));

const ask = (reason: string) => note("ask", reason);

/** A verdict with its reason on one line, at most 300 characters. */
export function note(verdict: CheckerVerdict, reason: string): CheckerNote {
  const r = clip(splitWhitespace(reason).join(" "), 300);
  return { verdict, reason: r === "" || r.length > 300 ? "no reason given" : r };
}

/** How the checker's turn ended: its reply, a safety refusal, or a failure (or a timeout). */
export type Answer = { reply: string } | { refused: true } | { failed: string };

/** Claude Code's words for a reply the model refused. */
export function refused(text: string): boolean {
  const t = text.toLowerCase();
  return t.includes("usage policy") || t.includes("unable to respond to this request");
}

/** The verdict in the checker's reply: its one JSON object, fenced or not. Undefined for anything else. */
export function parseReply(reply: string): CheckerNote | undefined {
  const [start, end] = [reply.indexOf("{"), reply.lastIndexOf("}")];
  if (start < 0 || end < start) return undefined;
  const v = parseJson(reply.slice(start, end + 1));
  const verdict = str(v, "verdict");
  const reason = str(v, "reason");
  if (verdict === undefined || reason === undefined) return undefined;
  const lower = verdict.trim().toLowerCase();
  if (lower !== "go" && lower !== "ask" && lower !== "block") return undefined;
  const r = reason.trim();
  return r === "" ? undefined : note(lower, r);
}

const RANK: Record<CheckerVerdict, number> = { go: 0, ask: 1, block: 2 };

/** The verdict: the code rules' floor and minimum, and the checker's answer above them. A refusal, a failure or an unreadable answer asks. */
export function decide(review: Review, answer: Answer): CheckerNote {
  let model: CheckerNote;
  if ("refused" in answer) model = ask("the checker flagged this as a likely attack");
  else if ("failed" in answer) model = ask(`the checker didn't answer (${answer.failed}), so you decide`);
  else if (refused(answer.reply)) model = ask("the checker flagged this as a likely attack");
  else model = parseReply(answer.reply) ?? ask("the checker's answer couldn't be read, so you decide");
  const rule = rules(review);
  return rule && RANK[rule.verdict] > RANK[model.verdict] ? rule : model;
}
