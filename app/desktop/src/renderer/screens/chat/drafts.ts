// Each project's unsent words and attachments, for the window's life rather than the chat view's: leave a project
// mid-sentence (or mid-upload) and it is all still in the box when you come back. Uploads go through the data
// layer's call and land here even if the view has gone. The words also outlive the app (persistDrafts); files
// don't, since an upload the hub never saw sent isn't worth keeping.

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { AttachmentMime, AttachmentRef } from "../../../shared/contracts";
import type { DataLayer } from "../../src/data/queries";
import { useDataLayer } from "../../src/data/react";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_PART_BYTES } from "../../../shared/contracts";
import { fmtBytes, looksText, MAX_ATTACHMENTS, mimeFor, toBase64 } from "./attachments";

/** Uploaded: the hub's reference to the file, which a message carries. */
export type Upload = { readonly ok: true; readonly ref: AttachmentRef } | { readonly ok: false; readonly message: string };

export interface Attached {
  readonly local: number;
  readonly name: string;
  readonly bytes: number;
  /** Undefined while it uploads. */
  readonly upload?: Upload;
}

export interface Draft {
  readonly text: string;
  readonly attached: readonly Attached[];
  /** Why the last attach or send didn't go, in a sentence. */
  readonly error?: string;
}

export const emptyDraft: Draft = { text: "", attached: [] };

type State = Readonly<Record<string, Draft>>;

export interface Drafts {
  readonly store: StoreApi<State>;
  set(key: string, next: (now: Draft) => Draft): void;
  /** Uploads each file (attachment_put); a refused one says why. */
  attach(key: string, files: readonly File[]): void;
  /** A message that didn't go, back in the box: its words after any already there, and its files, already uploaded. */
  restore(key: string, text: string, files: readonly AttachmentRef[]): void;
}

const isEmpty = (d: Draft) => d.text === "" && d.attached.length === 0 && d.error === undefined;

/** A call carries at most a piece's worth, so a larger file goes as attachment_part pieces, in order, then its last. */
export async function upload(layer: Pick<DataLayer, "call">, file: File, mime: AttachmentMime): Promise<Upload> {
  const piece = (at: number) => file.slice(at, Math.min(at + ATTACHMENT_PART_BYTES, file.size)).arrayBuffer().then(toBase64);
  const failed = (o: { readonly error: { readonly message: string } }): Upload => ({ ok: false, message: o.error.message });
  let uploadId: string | undefined;
  let at = 0;
  for (; at + ATTACHMENT_PART_BYTES < file.size; at += ATTACHMENT_PART_BYTES) {
    const o = await layer.call("attachment_part", { ...(uploadId === undefined ? {} : { uploadId, offset: at }), dataB64: await piece(at) }, { timeoutMs: 120_000 });
    if (!o.ok) return failed(o);
    uploadId = o.output.uploadId;
  }
  const o = await layer.call("attachment_put", { name: file.name, mime, dataB64: await piece(at), ...(uploadId === undefined ? {} : { uploadId }) }, { timeoutMs: 120_000 });
  return o.ok ? { ok: true, ref: { attachmentId: o.output.attachmentId, name: file.name, mime, bytes: o.output.bytes } } : failed(o);
}

export function createDrafts(layer: Pick<DataLayer, "call">, saved: Readonly<Record<string, string>> = {}): Drafts {
  const store = createStore<State>(() => Object.fromEntries(Object.entries(saved).map(([k, text]) => [k, { text, attached: [] }])));
  let nextLocal = 0;
  const set = (key: string, next: (now: Draft) => Draft) =>
    store.setState((s) => {
      const d = next(s[key] ?? emptyDraft);
      return Object.fromEntries([...Object.entries(s).filter(([k]) => k !== key), ...(isEmpty(d) ? [] : [[key, d] as const])]);
    }, true);
  const settle = (key: string, local: number, upload: Upload | undefined, error?: string) =>
    set(key, (d) => ({
      ...d,
      attached: upload ? d.attached.map((a) => (a.local === local ? { ...a, upload } : a)) : d.attached.filter((a) => a.local !== local),
      ...(error === undefined ? {} : { error }),
    }));
  return {
    store,
    set,
    restore: (key, text, files) =>
      set(key, (d) => {
        const room = Math.max(0, MAX_ATTACHMENTS - d.attached.length);
        const left = files.length - room;
        return {
          ...d,
          text: d.text.trim() === "" ? text : `${d.text}\n\n${text}`,
          attached: [...d.attached, ...files.slice(0, room).map((ref): Attached => ({ local: nextLocal++, name: ref.name, bytes: ref.bytes, upload: { ok: true, ref } }))],
          ...(left > 0 ? { error: `A message carries at most ${MAX_ATTACHMENTS} files; ${left} of its files didn’t fit.` } : {}),
        };
      }),
    attach: (key, files) => {
      let count = (store.getState()[key] ?? emptyDraft).attached.length;
      for (const file of files) {
        if (count >= MAX_ATTACHMENTS) {
          set(key, (d) => ({ ...d, error: `A message carries at most ${MAX_ATTACHMENTS} files.` }));
          return;
        }
        if (file.size > ATTACHMENT_MAX_BYTES) {
          set(key, (d) => ({ ...d, error: `${file.name} is ${fmtBytes(file.size)}; a file is at most ${ATTACHMENT_MAX_BYTES / 1_048_576} MB.` }));
          continue;
        }
        count++;
        const local = nextLocal++;
        set(key, (d) => {
          const { error: _, ...rest } = d;
          return { ...rest, attached: [...d.attached, { local, name: file.name, bytes: file.size }] };
        });
        void file.slice(0, 4096).arrayBuffer().then(async (head) => {
          const mime = mimeFor(file.name, looksText(head));
          if (!mime) return settle(key, local, undefined, `${file.name}: only images, text and PDF files attach.`);
          settle(key, local, await upload(layer, file, mime));
        });
      }
    },
  };
}

const STORAGE_KEY = "fleetd.drafts.v1";
/** Writes wait for typing to pause; quitting writes at once. */
const SAVE_AFTER_MS = 300;

export const readSaved = (storage: Pick<Storage, "getItem">): Record<string, string> => {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}");
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""));
  } catch {
    return {};
  }
};

/** Keeps each project's words in `storage` as they change. Returns the flush, which writes a pending change now. */
export function persistDrafts(drafts: Drafts, storage: Pick<Storage, "setItem" | "removeItem">): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = "";
  const write = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const texts = Object.fromEntries(Object.entries(drafts.store.getState()).flatMap(([k, d]) => (d.text.trim() === "" ? [] : [[k, d.text] as const])));
    const json = JSON.stringify(texts);
    if (json === last) return;
    last = json;
    try {
      if (json === "{}") storage.removeItem(STORAGE_KEY);
      else storage.setItem(STORAGE_KEY, json);
    } catch {
      // Storage full or unavailable: the words still live for the window's life.
    }
  };
  drafts.store.subscribe((next, prev) => {
    if (timer !== undefined) return;
    if (Object.keys(next).length === Object.keys(prev).length && Object.entries(next).every(([k, d]) => prev[k]?.text === d.text)) return;
    timer = setTimeout(write, SAVE_AFTER_MS);
  });
  return () => {
    if (timer !== undefined) write();
  };
}

const all = new WeakMap<object, Drafts>();
const flushes = new Set<() => void>();

/** Writes any unsaved words now: before the app restarts itself (an update). Quitting flushes on its own. */
const flushDrafts = (): void => {
  for (const flush of flushes) flush();
};

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushDrafts);
  window.addEventListener("beforeunload", flushDrafts);
}

export function useDrafts(): Drafts {
  const layer = useDataLayer();
  let d = all.get(layer);
  if (d === undefined) {
    d = createDrafts(layer, readSaved(window.localStorage));
    flushes.add(persistDrafts(d, window.localStorage));
    all.set(layer, d);
  }
  return d;
}

export function useDraft(key: string): [Draft, (next: (now: Draft) => Draft) => void, Drafts] {
  const drafts = useDrafts();
  const draft = useStore(drafts.store, (s) => s[key] ?? emptyDraft);
  return [draft, (next) => drafts.set(key, next), drafts];
}
