// A page left open learns that the cloud serves a newer build and switches to it by itself, with no banner: it asks
// for index.html now and then (past the service worker, which leaves a page's own fetch to the network) and compares
// the script it starts from with its own, named by content. Once one differs, the page loads again, `fresh` (so no
// worker serves it an older index), once its tab is hidden, or at once on the person's next move to another screen.
// Never in sight otherwise (people read long chats and watch screens without a key or pointer), never offline (the new
// build's page couldn't load), and never while a field holds words they typed in this load, a dialog is open, or a
// draft holds files (only a draft's words outlive a reload).
import { FRESH_LOAD } from "./shell";

/** How often an open page asks which build is current. */
export const CHECK_EVERY_MS = 5 * 60_000;
/** The least time between two asks on coming back (focus, shown, online). */
export const CHECK_GAP_MS = 60_000;
/** How often the page looks again whether it may switch. */
const TICK_MS = 60_000;
/** After a move to another screen: its screen drawn before the fields are looked at. */
const DRAWN_MS = 250;
const EDITABLE = 'textarea, [contenteditable]:not([contenteditable="false"]), input:not([type="button"], [type="checkbox"], [type="color"], [type="file"], [type="hidden"], [type="image"], [type="radio"], [type="range"], [type="reset"], [type="submit"])';

/** The script an index.html starts from, its build's entry, or null (the dev server's index names none). */
export const entryOf = (html: string): string | null => /<script\b[^>]*\ssrc="(\/assets\/[^"]+\.js)"/.exec(html)?.[1] ?? null;

export interface NewBuildDeps {
  /** The entry this page started from (`entryOf` its own index); null, it isn't a built page and nothing runs. */
  readonly own: string | null;
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Loads `url` in this page's place. */
  readonly go: (url: string) => void;
  /** Whether the page holds what a reload would lose and no field shows: a draft's files. */
  readonly holding: () => boolean;
}

export const followNewBuild = (page: Pick<Window, "document" | "location" | "sessionStorage" | "addEventListener">, deps: NewBuildDeps): void => {
  const own = deps.own;
  if (own === null) return;
  const { document } = page;
  let newer = false;
  let checked = Number.NEGATIVE_INFINITY;
  /** The fields typed into in this load; one gone from the page no longer counts. */
  const typed = new Set<Element>();

  const holdsWords = (el: Element) => ("value" in el ? String(el.value) : el.textContent).trim() !== "";
  const busy = () => {
    for (const el of typed) if (!el.isConnected) typed.delete(el);
    return [...typed].some(holdsWords) || document.querySelector('[role="dialog"], [role="alertdialog"]') !== null || deps.holding();
  };
  const maybe = (navigated: boolean) => {
    if (!newer || !navigator.onLine || busy() || !(navigated || document.visibilityState === "hidden")) return;
    newer = false;
    const url = new URL(page.location.href);
    url.searchParams.set("fresh", "1");
    // This load is the new build's first: a chunk failing in it may still load the page again (shell.ts).
    page.sessionStorage.removeItem(FRESH_LOAD);
    deps.go(url.toString());
  };
  const check = async () => {
    checked = Date.now();
    try {
      const answer = await deps.fetch("/index.html", { cache: "no-store" });
      const entry = answer.ok ? entryOf(await answer.text()) : null;
      if (entry !== null && entry !== own) newer = true;
    } catch {
      // Offline or a deploy's restart: asked again later.
    }
    maybe(false);
  };
  const soon = () => {
    if (Date.now() - checked >= CHECK_GAP_MS) void check();
    else maybe(false);
  };

  document.addEventListener(
    "input",
    (event) => {
      if (event.target instanceof Element && event.target.matches(EDITABLE)) typed.add(event.target);
    },
    true,
  );
  page.addEventListener("hashchange", () => void setTimeout(() => maybe(true), DRAWN_MS));
  page.addEventListener("focus", soon);
  page.addEventListener("online", soon);
  document.addEventListener("visibilitychange", () => (document.visibilityState === "visible" ? soon() : maybe(false)));
  setInterval(() => (Date.now() - checked >= CHECK_EVERY_MS ? void check() : maybe(false)), TICK_MS);
  void check();
};
