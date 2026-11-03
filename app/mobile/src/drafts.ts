// What you were writing in each chat, as Messages and Telegram keep it: the words, the files picked for it and the
// bubble it replies to, kept while you look at another chat and when the app starts again. Pure, so it is
// unit-tested; draftsStore.ts keeps it on disk. A file still uploading, or one the hub didn't take, lives only while
// the app runs: after a restart its upload is gone, so it would never finish.
import type { AttachmentRef } from "./desktop";
import type { Key } from "./store";

/** A file on its way into the message: a picture's own uri for its thumbnail, its progress, then the hub's reference. */
export interface DraftFile {
  readonly id: number;
  readonly name: string;
  readonly image: string | undefined;
  readonly progress: number;
  readonly ref?: AttachmentRef;
  readonly error?: string;
}

/** The bubble a draft answers, and its quote above the field. */
export interface DraftReply {
  readonly id: string;
  readonly part: number;
  /** Whose bubble it answers. */
  readonly who: string;
  readonly quote: string;
}

export interface Draft {
  readonly text: string;
  readonly files: readonly DraftFile[];
  readonly reply: DraftReply | undefined;
}

export type Drafts = Readonly<Record<Key, Draft>>;

export const emptyDraft: Draft = { text: "", files: [], reply: undefined };

export const isEmpty = (d: Draft): boolean => d.text === "" && d.files.length === 0 && d.reply === undefined;

/**
 * The composer's round button: Send once there's something to send and nothing still uploading; Stop while the lead
 * works (`canStop`) and nothing is written or picked, since anything written goes as a message it reads at its next
 * step; else none.
 */
export const sendSlot = (d: Draft, canStop: boolean): "send" | "stop" | "none" => {
  const uploading = d.files.some((f) => f.ref === undefined && f.error === undefined);
  if ((d.text.trim() !== "" || d.files.some((f) => f.ref !== undefined)) && !uploading) return "send";
  return canStop && d.text.trim() === "" && d.files.length === 0 ? "stop" : "none";
};

/** A chat's draft changed: one left empty is forgotten. */
export const withDraft = (drafts: Drafts, key: Key, change: (d: Draft) => Draft): Drafts => {
  const before = drafts[key] ?? emptyDraft;
  const after = change(before);
  if (after === before) return drafts;
  if (!isEmpty(after)) return { ...drafts, [key]: after };
  if (drafts[key] === undefined) return drafts;
  const rest: Record<Key, Draft> = { ...drafts };
  delete rest[key];
  return rest;
};

/** What goes to disk: each draft with only its files the hub has, and none left empty by that. */
export const kept = (drafts: Drafts): Drafts => {
  const out: Record<Key, Draft> = {};
  for (const [key, d] of Object.entries(drafts)) {
    const files = d.files.filter((f) => f.ref !== undefined && f.error === undefined);
    const draft = files.length === d.files.length ? d : { ...d, files };
    if (!isEmpty(draft)) out[key] = draft;
  }
  return out;
};

const str = (v: unknown): v is string => typeof v === "string";
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const fileOf = (v: unknown): DraftFile | undefined => {
  if (typeof v !== "object" || v === null) return undefined;
  const f = v as Record<string, unknown>;
  const ref = f.ref as Record<string, unknown> | undefined;
  if (!num(f.id) || !str(f.name) || typeof ref !== "object" || ref === null || !str(ref.attachmentId)) return undefined;
  return { id: f.id, name: f.name, image: str(f.image) ? f.image : undefined, progress: 1, ref: ref as unknown as AttachmentRef };
};

const replyOf = (v: unknown): DraftReply | undefined => {
  if (typeof v !== "object" || v === null) return undefined;
  const r = v as Record<string, unknown>;
  return str(r.id) && num(r.part) && str(r.who) && str(r.quote) ? { id: r.id, part: r.part, who: r.who, quote: r.quote } : undefined;
};

/** The drafts file as read back: whatever doesn't look like a draft is left out, never thrown. */
export const parseDrafts = (v: unknown): Drafts => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
  const out: Record<Key, Draft> = {};
  for (const [key, raw] of Object.entries(v as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const d = raw as Record<string, unknown>;
    const draft: Draft = {
      text: str(d.text) ? d.text : "",
      files: Array.isArray(d.files) ? d.files.flatMap((f) => fileOf(f) ?? []) : [],
      reply: replyOf(d.reply),
    };
    if (!isEmpty(draft)) out[key] = draft;
  }
  return out;
};
