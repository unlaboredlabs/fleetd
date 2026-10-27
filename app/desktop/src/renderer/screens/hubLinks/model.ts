// Hub links (D194, docs/design/hubs.md) as plain view data. A link key minted on one hub acts as its person there; a
// Navi on another hub keeps it sealed and reaches that hub's projects through it. Here: what a pasted key text holds,
// the words for a kept link's state, and the lines for a minted link. Pure, so it is unit-tested.
import type { HubLink, IssuedLink, ProjectRef } from "../../../shared/contracts";

/** As the hub takes a link's label (HubLabel): 1 to 40 characters on one line. */
export const LABEL_MAX = 40;

const URL_RE = /\bhttps?:\/\/[^\s]+/u;

/**
 * What a pasted text holds: the link key, and the hub's address when it came with one (Links to this hub copies
 * both, on two lines). A key alone is fine; the address is then typed.
 */
export const readPasted = (text: string): { key: string | undefined; url: string | undefined } => {
  const key = /flk_[a-z2-7]{52}/u.exec(text)?.[0];
  // A one-line box joins the two lines: the address ends where the key starts.
  const rest = key === undefined ? text : text.replace(key, " ");
  return { key, url: URL_RE.exec(rest)?.[0]?.replace(/\/+$/u, "") };
};

/** The text Links to this hub copies: this hub's address, then the key. */
export const pasteText = (url: string, key: string): string => `${url}\n${key}`;

/** Why the hub wouldn't take `label`, in a few words; undefined when it would. An empty box says nothing yet. */
export const labelProblem = (label: string, taken: ReadonlyArray<string> = []): string | undefined => {
  const t = label.trim();
  if (t.length > LABEL_MAX) return `Keep it under ${String(LABEL_MAX)} characters`;
  if (/[\r\n]/u.test(label)) return "One line";
  if (taken.some((x) => x.toLowerCase() === t.toLowerCase())) return "This Navi has a linked hub called that already";
  return undefined;
};

/** Why `url` can't be a hub's address, in a few words; the hub checks the rest (https, or http over a tailnet). */
export const urlProblem = (url: string): string | undefined => {
  const t = url.trim();
  if (t === "") return undefined;
  return /^https?:\/\/[^\s/]+/u.test(t) ? undefined : "An address like https://hub.example.com";
};

export interface LinkState {
  /** One word for the row. */
  readonly word: string;
  /** What it means, in a sentence; null when it works. */
  readonly line: string | null;
  /** What to do about it; null when nothing. */
  readonly fix: string | null;
  readonly tone: "quiet" | "danger";
}

/** The other hub's words without its id for the link ("The link hl_ab2c… was revoked" → "The link was revoked"). */
const withoutId = (text: string): string => text.replace(/\s*\bhl_[a-z2-7]{8}\b/gu, "");

/** A kept link's state, plainly: working, can't reach the other hub (with its address), or revoked there. */
export const linkState = (link: Pick<HubLink, "label" | "url" | "state" | "error">): LinkState => {
  switch (link.state) {
    case "ok":
      return { word: "Working", line: null, fix: null, tone: "quiet" };
    case "unreachable":
      return {
        word: "Can’t reach",
        line: link.error ?? `Can’t reach ${link.label} at ${link.url}.`,
        fix: `A hub link needs ${link.label}’s hub reachable from this hub, over a tailnet or HTTPS. The Navi’s requests there fail until it is.`,
        tone: "danger",
      };
    case "revoked":
      return {
        word: "Revoked",
        // The other hub's reason is in its own words ("revoked on this hub"), so it is quoted as that hub's.
        line: `Revoked on ${link.label}: this Navi can’t use it any more.${link.error === undefined ? "" : ` ${link.label} says: “${withoutId(link.error)}”`}`,
        fix: `Remove it, or make a new link key on ${link.label} and add that.`,
        tone: "danger",
      };
    default:
      return { word: link.state, line: link.error ?? null, fix: null, tone: "quiet" };
  }
};

/** Who a kept link acts as there, and what it reaches: "As Alex · Storefront, Checkout", or "As Alex · every project of theirs". */
export const reachLine = (link: Pick<HubLink, "who" | "projects">): string | null => {
  const projects = link.projects === undefined ? null : link.projects.map((p) => p.title).join(", ");
  if (link.who === undefined) return projects === null ? null : `Only ${projects}`;
  return `As ${link.who} · ${projects === null ? "every project of theirs" : `only ${projects}`}`;
};

/** A minted link's projects, by title where this app knows them. */
export const projectsLine = (link: Pick<IssuedLink, "projects">, titleOf: (p: ProjectRef) => string | undefined): string =>
  link.projects === undefined ? "Every project" : `Only ${link.projects.map((p) => titleOf(p) ?? p.projectId).join(", ")}`;

/** Its person, or its device on a hub from before people. */
export const whoOf = (link: Pick<IssuedLink, "person" | "device">): string => link.person?.name ?? link.device;

/** Open links first, newest first; then revoked ones, newest revoked first. */
export const sortIssued = (links: ReadonlyArray<IssuedLink>): IssuedLink[] =>
  links.toSorted((a, b) => {
    if ((a.revokedAt === undefined) !== (b.revokedAt === undefined)) return a.revokedAt === undefined ? -1 : 1;
    return (b.revokedAt ?? b.createdAt).localeCompare(a.revokedAt ?? a.createdAt);
  });

/** The links made as this person: theirs by person, or (on a hub from before people) everything the hub returned. */
export const mine = (links: ReadonlyArray<IssuedLink>, personId: string | undefined): IssuedLink[] =>
  personId === undefined ? [...links] : links.filter((l) => l.person?.personId === personId);
