// A final lead message's bubbles (crates/fleetd/src/hub/chat/parts.rs). The lead separates bubbles with a blank line,
// as it separates paragraphs, so a reply reads the same in a client that shows `text` whole. A code fence is a bubble
// of its own and never split; a list or table stays one bubble across the blank lines of a loose list. A
// ```fleetd-block fence becomes a block when it passes `block`, and otherwise shows as the fence it is; a ```json or
// untagged fence becomes one only when its whole body is a block that passes every check. The lead hears of either
// case with its next wake (`unshown`).
import chatBlockSchema from "../../../../app/desktop/src/shared/contracts/schema/ChatBlock.json";
import type { ChatBlock, ChatMessage, ChatPart } from "../../shared/contracts.ts";
import { SchemaCheck } from "./schema.ts";

export const BLOCK_FENCE = "fleetd-block";
export const BLOCK_JSON_MAX = 16_000;
export const CHAT_PARTS_MAX = 24;

const SCHEMA = new SchemaCheck(chatBlockSchema as Record<string, unknown>);

/** A tag, a script scheme, or a URL: a block's strings carry none. */
const UNSAFE = /<[a-z!/?]|\b(javascript|vbscript):|\bdata:[a-z]|:\/\//i;

type Json = Record<string, unknown>;

const defs = (chatBlockSchema as { $defs: Record<string, Json> }).$defs;
const KIND_DEF: Record<string, string> = {
  chart: "ChartBlock",
  table: "TableBlock",
  diff: "DiffBlock",
  pr: "PrBlock",
  agent: "AgentBlock",
  checklist: "ChecklistBlock",
  image: "AttachmentBlock",
  clip: "AttachmentBlock",
  file: "AttachmentBlock",
  ask: "AskBlock",
};

/** The rules the schema can't say (the contracts' `checked!`). */
function extra(v: Json): string | undefined {
  switch (v.kind) {
    case "chart":
      return (v.series as { values: unknown[] }[]).some((s) => s.values.length !== (v.x as unknown[]).length)
        ? "each series has one value per x label"
        : undefined;
    case "table":
      return (v.rows as unknown[][]).some((r) => r.length !== (v.columns as unknown[]).length)
        ? "each row has one cell per column"
        : undefined;
    case "diff":
      return (v.files === undefined) === (v.pr === undefined) ? "a diff has files or a pr, not both" : undefined;
    case "agent":
      return (v.taskId === undefined) === (v.threadRef === undefined)
        ? "an agent block names a taskId or a threadRef, not both"
        : undefined;
  }
  return undefined;
}

/** The block as serde reads it back: its kind's declared fields only, in the struct's order. */
function cleaned(v: Json): ChatBlock {
  const def = defs[KIND_DEF[v.kind as string] ?? ""] as { properties?: Json } | undefined;
  const out: Json = { v: v.v, kind: v.kind };
  for (const key of Object.keys(def?.properties ?? {})) if (v[key] !== undefined && v[key] !== null) out[key] = v[key];
  return out as ChatBlock;
}

function safe(value: unknown): boolean {
  if (typeof value === "string") return !UNSAFE.test(value);
  if (Array.isArray(value)) return value.every(safe);
  if (value && typeof value === "object") return Object.entries(value).every(([k, v]) => k === "hunks" || safe(v));
  return true;
}

function checked(value: unknown): ChatBlock | string {
  if (!safe(value)) return "a string in it holds markup, a script scheme or a URL";
  const why = SCHEMA.check(value);
  if (why !== undefined) return why;
  const more = extra(value as Json);
  return more ?? cleaned(value as Json);
}

/**
 * One block's JSON, checked: within BLOCK_JSON_MAX, the schema, and no markup or URL in its strings (a diff's hunks
 * excepted). The block, or the rule it broke; an image, clip or file whose caption alone is wrong shows without it,
 * and the lead still hears why.
 */
export function block(json: string): { block?: ChatBlock; why?: string } {
  const bytes = Buffer.byteLength(json);
  if (bytes > BLOCK_JSON_MAX) return { why: `it is ${bytes} bytes of JSON, over the ${BLOCK_JSON_MAX} a block holds` };
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    return { why: `its JSON doesn't parse (${(error as Error).message})` };
  }
  const first = checked(value);
  if (typeof first !== "string") return { block: first };
  const v = value as Json | null;
  const media = v !== null && typeof v === "object" && ["image", "clip", "file"].includes(v.kind as string);
  if (media && v.caption !== undefined) {
    delete v.caption;
    const again = checked(v);
    if (typeof again !== "string") return { block: again, why: first };
  }
  return { why: first };
}

/** A ```json or untagged fence whose whole body is one block that passes every check. */
function promoted(json: string): ChatBlock | undefined {
  if (Buffer.byteLength(json) > BLOCK_JSON_MAX || !json.trimStart().startsWith("{")) return undefined;
  try {
    const out = checked(JSON.parse(json));
    return typeof out === "string" ? undefined : out;
  } catch {
    return undefined;
  }
}

/** The opening line of a code fence: its marker (``` or ~~~, at least three) and its info string. */
function fenceOpen(line: string): [string, string] | undefined {
  const trimmed = line.trimStart();
  if (line.length - trimmed.length > 3) return undefined;
  const c = trimmed[0];
  if (c !== "`" && c !== "~") return undefined;
  let n = 0;
  while (trimmed[n] === c) n++;
  return n >= 3 ? [trimmed.slice(0, n), trimmed.slice(n).trim()] : undefined;
}

function fenceCloses(line: string, marker: string): boolean {
  const t = line.trim();
  return t.startsWith(marker) && [...t].every((c) => marker.startsWith(c));
}

type Kind = "prose" | "list" | "table";

function kind(line: string): Kind {
  const t = line.trimStart();
  const m = /^([^.)]*)[.)]/.exec(t);
  const numbered = !!m && m[1] !== undefined && m[1].length > 0 && m[1].length <= 3 && /^[0-9]+$/.test(m[1]) && t[m[0].length] === " ";
  if (t.startsWith("|")) return "table";
  if (numbered || ["- ", "* ", "+ "].some((b) => t.startsWith(b)) || line.length > t.length) return "list";
  return "prose";
}

type Bubble = { start: number; end: number; fence?: [info: string, body: number, bodyEnd: number] };

/** Ranges of the bubbles (UTF-16 offsets into `text`), in order. */
function bubbles(text: string): Bubble[] {
  const out: Bubble[] = [];
  let open: Bubble | undefined;
  let last: Kind = "prose";
  let gap = false;
  let fence: [marker: string, info: string, start: number, body: number] | undefined;
  let at = 0;
  const lines = text.split(/(?<=\n)/);
  for (const raw of lines) {
    if (raw === "") continue;
    const start = at;
    const end = at + raw.replace(/[\n\r]+$/, "").length;
    at += raw.length;
    const line = text.slice(start, end);
    if (fence) {
      if (fenceCloses(line, fence[0])) {
        out.push({ start: fence[2], end, fence: [fence[1], fence[3], start] });
        fence = undefined;
      }
      continue;
    }
    const opened = fenceOpen(line);
    if (opened) {
      if (open) out.push(open);
      open = undefined;
      fence = [opened[0], opened[1], start, at];
      gap = false;
      continue;
    }
    if (line.trim() === "") {
      gap = open !== undefined;
      continue;
    }
    const now = kind(line);
    const joins = !gap || (now === last && now !== "prose");
    if (open && joins) open.end = end;
    else {
      if (open) out.push(open);
      open = { start, end };
    }
    last = now;
    gap = false;
  }
  if (open) out.push(open);
  if (fence) {
    const end = Math.max(text.trimEnd().length, fence[2]);
    out.push({ start: fence[2], end, fence: [fence[1], Math.min(fence[3], end), end] });
  }
  return out;
}

type Note = { kind: "failed"; n: number; why: string } | { kind: "captionless"; n: number; why: string } | { kind: "promoted"; n: number; fence: string };

function split(text: string): { parts: ChatPart[]; notes: Note[] } {
  const found = bubbles(text);
  const isBlock = (b: Bubble) => b.fence?.[0] === BLOCK_FENCE;
  let over = 0;
  if (found.length > CHAT_PARTS_MAX) {
    over = found.slice(CHAT_PARTS_MAX - 1).filter(isBlock).length;
    const end = (found[found.length - 1] as Bubble).end;
    found.length = CHAT_PARTS_MAX;
    const lastBubble = found[CHAT_PARTS_MAX - 1] as Bubble;
    lastBubble.end = end;
    delete lastBubble.fence;
  }
  let blocks = 0;
  const notes: Note[] = [];
  const parts = found.map((b): ChatPart => {
    let made: ChatBlock | undefined;
    if (b.fence) {
      const [info, body, bodyEnd] = b.fence;
      if (info === BLOCK_FENCE) {
        blocks += 1;
        const { block: got, why } = block(text.slice(body, bodyEnd));
        made = got;
        if (why !== undefined) notes.push(got ? { kind: "captionless", n: blocks, why } : { kind: "failed", n: blocks, why });
      } else if (info === "" || info.toLowerCase() === "json") {
        made = promoted(text.slice(body, bodyEnd));
        if (made) {
          blocks += 1;
          notes.push({ kind: "promoted", n: blocks, fence: info === "" ? "untagged ```" : "```json" });
        }
      }
    }
    return { start: b.start, end: b.end, ...(made ? { block: made } : {}) } as ChatPart;
  });
  const past = `a message shows at most ${CHAT_PARTS_MAX} bubbles (paragraphs, fences and blocks); send the rest in another`;
  for (let n = blocks + 1; n <= blocks + over; n++) notes.push({ kind: "failed", n, why: past });
  return { parts, notes };
}

/** The message's parts: undefined when it is one text bubble. */
export function parts(text: string): ChatPart[] | undefined {
  const { parts: out } = split(text);
  if (out.length === 0 || (out.length === 1 && (out[0] as ChatPart).block === undefined)) return undefined;
  return out;
}

/** What the lead should hear of its message's blocks, as one line; undefined when every block showed as written. */
export function unshown(text: string): string | undefined {
  const { notes } = split(text);
  if (notes.length === 0) return undefined;
  const all = notes
    .map((n) =>
      n.kind === "failed"
        ? `block ${n.n} didn't show: ${n.why}`
        : n.kind === "captionless"
          ? `block ${n.n} showed without its caption: ${n.why}`
          : `block ${n.n} showed, but I rendered your ${n.fence} fence as a block; tag it fleetd-block`,
    )
    .join("; ");
  const failed = notes.some((n) => n.kind === "failed");
  return `- in your last message, ${all}${
    failed
      ? '; the person sees a "couldn\'t show this" chip for each block that didn\'t show: fix and send again if it matters'
      : ""
  }`;
}

/** One bubble's text, trimmed: `part` of the message's parts, or the whole text for a message of one bubble. */
export function bubble(message: ChatMessage, part: number): string | undefined {
  const text = message.text;
  if (!message.parts) return part === 0 && text.trim() ? text.trim() : undefined;
  const p = message.parts[part];
  if (!p || p.end > text.length) return undefined;
  return text.slice(p.start, p.end).trim();
}
