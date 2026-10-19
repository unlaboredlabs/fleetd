// Each project's unsent words and attachments, for the window's life rather than the chat view's: leave a project
// mid-sentence (or mid-upload) and it is all still in the box when you come back. Uploads go through the data
// layer's call and land here even if the view has gone.

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { DataLayer } from "../../src/data/queries";
import { useDataLayer } from "../../src/data/react";
import { fmtBytes, looksText, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, mimeFor, toBase64 } from "./attachments";

export type Upload = { readonly ok: true; readonly id: string } | { readonly ok: false; readonly message: string };

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
  /** The last send found no hub: said under the box until the words change or go. */
  readonly offline?: boolean;
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
}

const isEmpty = (d: Draft) => d.text === "" && d.attached.length === 0 && d.offline !== true && d.error === undefined;

export function createDrafts(layer: Pick<DataLayer, "call">): Drafts {
  const store = createStore<State>(() => ({}));
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
    attach: (key, files) => {
      let count = (store.getState()[key] ?? emptyDraft).attached.length;
      for (const file of files) {
        if (count >= MAX_ATTACHMENTS) {
          set(key, (d) => ({ ...d, error: `A message carries at most ${MAX_ATTACHMENTS} files.` }));
          return;
        }
        if (file.size > MAX_ATTACHMENT_BYTES) {
          set(key, (d) => ({ ...d, error: `${file.name} is ${fmtBytes(file.size)}; a file is at most 5 MB.` }));
          continue;
        }
        count++;
        const local = nextLocal++;
        set(key, (d) => {
          const { error: _, ...rest } = d;
          return { ...rest, attached: [...d.attached, { local, name: file.name, bytes: file.size }] };
        });
        void file.arrayBuffer().then(async (buf) => {
          const mime = mimeFor(file.name, looksText(buf));
          if (!mime) return settle(key, local, undefined, `${file.name}: only images, text and PDF files attach.`);
          const o = await layer.call("attachment_put", { name: file.name, mime, dataB64: toBase64(buf) }, { timeoutMs: 120_000 });
          settle(key, local, o.ok ? { ok: true, id: o.output.attachmentId } : { ok: false, message: o.error.message });
        });
      }
    },
  };
}

const all = new WeakMap<object, Drafts>();

export function useDrafts(): Drafts {
  const layer = useDataLayer();
  let d = all.get(layer);
  if (d === undefined) {
    d = createDrafts(layer);
    all.set(layer, d);
  }
  return d;
}

export function useDraft(key: string): [Draft, (next: (now: Draft) => Draft) => void, Drafts] {
  const drafts = useDrafts();
  const draft = useStore(drafts.store, (s) => s[key] ?? emptyDraft);
  return [draft, (next) => drafts.set(key, next), drafts];
}
