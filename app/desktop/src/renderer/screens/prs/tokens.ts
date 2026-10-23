// Syntax colours for a diff page, highlighted once when its first row is drawn and shared by every row of it. Each
// side of the page is one text to the highlighter (whole runs of code, not single lines); off-screen pages are never
// highlighted, and a page too big to highlight stays plain.
import { useSyncExternalStore } from "react";
import { highlight, langForPath, type Tokens } from "../../ui";
import { sidesOf, type Page } from "./diffModel";

export interface PageTokens {
  readonly old: Tokens | null;
  readonly new: Tokens | null;
}

const done = new WeakMap<Page, PageTokens>();
const started = new WeakSet<Page>();
const listeners = new WeakMap<Page, Set<() => void>>();

const start = (page: Page): void => {
  if (started.has(page)) return;
  started.add(page);
  const lang = langForPath(page.path);
  if (lang === null) return;
  const { oldText, newText } = sidesOf(page);
  const side = (text: string) => (text === "" ? Promise.resolve(null) : highlight(text, lang).catch(() => null));
  void Promise.all([side(oldText), side(newText)]).then(([old, next]) => {
    done.set(page, { old, new: next });
    for (const l of listeners.get(page) ?? []) l();
  });
};

// One subscribe per page, so a re-render doesn't resubscribe.
const subscribers = new WeakMap<Page, (onChange: () => void) => () => void>();
const subscribeTo = (page: Page) => {
  let subscribe = subscribers.get(page);
  if (subscribe === undefined) {
    subscribe = (onChange) => {
      let set = listeners.get(page);
      if (set === undefined) {
        set = new Set();
        listeners.set(page, set);
      }
      set.add(onChange);
      start(page);
      return () => set.delete(onChange);
    };
    subscribers.set(page, subscribe);
  }
  return subscribe;
};

/** The page's tokens once highlighted; undefined until then (and for good when its language isn't known). */
export const usePageTokens = (page: Page): PageTokens | undefined => useSyncExternalStore(subscribeTo(page), () => done.get(page));
