// The bot's screens in its chat, as plain view data (the phone's screen cards, app/mobile/src/screen.ts, on the desktop
// and the web; where each card stands among the rows is screenRows.ts): what the card says (whose screen, its state, what it does now or why it asks, how long it ran) and which one button it
// has (Watch, Take over, Replay), and the strip over the composer while one asks for you. ScreenCard.tsx draws them.
// Pure, so it is unit-tested.
import { parseMs } from "../live/format";
import { durationOf, fmtDuration, isLive, nowLine, type BrowserSession } from "../sessions/model";

/** A screen's kind in a word, for its card's title. */
const KIND_WORD: Readonly<Record<NonNullable<BrowserSession["kind"]> | "browser", string>> = {
  browser: "browser",
  android: "Android emulator",
  ios: "iOS simulator",
  linux_desktop: "desktop",
  mac: "Mac screen",
};

const isLeads = (x: Pick<BrowserSession, "agent">): boolean => x.agent.role === "lead" || x.agent.laneId.startsWith("lead:");

/** Who drives it for the bot: the lead, named as the bot, or an agent, by its title. */
const agentName = (x: Pick<BrowserSession, "agent">, bot: string): string => (isLeads(x) ? bot : x.agent.title);

/**
 * A card's title: yours ("Your iOS simulator"), the lead's by the bot's name ("grokdemo’s browser"), an agent's its kind
 * first ("Browser · Checkout QA"), so a long title is what gets cut.
 */
export const titleOf = (x: Pick<BrowserSession, "openedBy" | "agent" | "kind">, bot: string): string => {
  const kind = KIND_WORD[x.kind ?? "browser"];
  if (x.openedBy !== undefined) return `Your ${kind}`;
  if (isLeads(x)) return `${bot}’s ${kind}`;
  return `${kind.charAt(0).toUpperCase()}${kind.slice(1)} · ${x.agent.title}`;
};

/** What a card's one button does: watch it live, take it over while it asks, its replay once it ended. */
export type CardAction = "watch" | "takeOver" | "replay" | "none";

export interface CardView {
  /** "grokdemo’s browser"; asking, its state says it needs you. */
  readonly title: string;
  /** Its state in a word or two, coloured as `tone` says: "live", "needs you", "Ended · 2:00". */
  readonly state: string;
  readonly tone: "default" | "warning" | "quiet" | "danger";
  /** What it does now, why it asks, or (ended) what it was for. */
  readonly line: string;
  readonly asking: boolean;
  readonly live: boolean;
  readonly action: CardAction;
}

/** What a screen's card says, `now` for how long an ended one ran. */
export const cardView = (x: BrowserSession, bot: string, now: number): CardView => {
  const live = isLive(x);
  const asking = x.state === "asking";
  const title = titleOf(x, bot);
  if (asking) return { title, state: "needs you", tone: "warning", line: x.handoff?.reason ?? x.purpose, asking, live, action: "takeOver" };
  if (live) {
    const state = x.state === "yours" ? "you’re in control" : x.state === "handingBack" ? "handed back" : x.state === "starting" ? "starting" : "live";
    // A person's own screen says what it is for; an agent's what it does now (the steps' labeller, sessions/hub.ts).
    const line = x.openedBy !== undefined || x.state === "starting" ? x.purpose : x.state === "yours" ? "Hand it back when you’re done" : nowLine(x);
    return { title, state, tone: "default", line, asking, live, action: "watch" };
  }
  const ran = fmtDuration(durationOf(x, now));
  switch (x.state) {
    case "saving":
      return { title, state: `Ended · ${ran}`, tone: "quiet", line: "Saving the recording", asking, live, action: "none" };
    case "lost":
      return { title, state: "Recording lost", tone: "danger", line: x.note ?? x.purpose, asking, live, action: "none" };
    case "expired":
      return { title, state: `Ended · ${ran}`, tone: "quiet", line: `${x.purpose} · its recording expired`, asking, live, action: "none" };
    default:
      return { title, state: `Ended · ${ran}`, tone: "quiet", line: x.purpose, asking, live, action: "replay" };
  }
};

/** The strip over the composer while a screen asks for you: the one to take over, and how many more ask. */
export interface AskStrip {
  readonly session: BrowserSession;
  readonly title: string;
  readonly more: number;
}

/** The oldest screen asking for you, with what the strip says; undefined while none asks. */
export const askStrip = (sessions: readonly BrowserSession[], bot: string): AskStrip | undefined => {
  const asking = sessions.filter((x) => x.state === "asking").toSorted((a, b) => (parseMs(a.startedAt) ?? 0) - (parseMs(b.startedAt) ?? 0));
  const first = asking[0];
  if (first === undefined) return undefined;
  // Short, beside what the lead waits on: the card in the chat and the tooltip say why.
  return { session: first, title: `${agentName(first, bot)} needs you`, more: asking.length - 1 };
};

/** How long a screen's machine keeps what its browser downloaded after it ends (node/browser/downloads.ts). */
export const DOWNLOADS_KEPT_MS = 24 * 60 * 60_000;

/**
 * An ended screen's downloads to offer: the ones the chat doesn't have yet (`inChat`, by name: the agent sent it, or a
 * person did), while its machine still keeps them.
 */
export const unsent = <D extends { readonly name: string }>(downloads: readonly D[], inChat: readonly string[], x: Pick<BrowserSession, "endedAt">, now: number): readonly D[] => {
  const ended = parseMs(x.endedAt);
  if (ended !== undefined && now - ended >= DOWNLOADS_KEPT_MS) return [];
  const there = new Set(inChat);
  return downloads.filter((d) => !there.has(d.name));
};
