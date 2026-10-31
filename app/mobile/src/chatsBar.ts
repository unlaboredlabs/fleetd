// What the chats list's bars say, as Messages' on iOS 26: at the top, the person's avatar, which opens Settings and
// carries the link to the hub as a dot; at the bottom, a round button whose menu picks a filter, beside the search
// field (screens/Chats.tsx, ui/Toolbar.tsx).
import type { SFSymbol } from "expo-symbols";
import type { HubState } from "./desktop";
import type { Filter } from "./lists";

export interface FilterChoice {
  readonly id: Filter;
  readonly title: string;
  readonly symbol: SFSymbol;
  /** How many chats it holds that want you, when any do. */
  readonly subtitle?: string;
}

const CHOICES: ReadonlyArray<Omit<FilterChoice, "subtitle">> = [
  { id: "all", title: "All Chats", symbol: "bubble.left.and.bubble.right" },
  { id: "unread", title: "Unread", symbol: "message.badge" },
  { id: "needsYou", title: "Needs You", symbol: "hand.raised" },
  { id: "pinned", title: "Pinned", symbol: "pin" },
  { id: "navis", title: "Navis", symbol: "sparkles" },
  { id: "projects", title: "Projects", symbol: "folder" },
];

/** The filters menu, in its order: Unread counts its chats, Needs You the chats with an approval waiting. */
export const filterChoices = (counts: { readonly unread: number; readonly needsYou: number }): readonly FilterChoice[] =>
  CHOICES.map((c) => {
    const n = c.id === "unread" ? counts.unread : c.id === "needsYou" ? counts.needsYou : 0;
    return n > 0 ? { ...c, subtitle: n === 1 ? "1 chat" : `${String(n)} chats` } : c;
  });

/** The filter button's name for VoiceOver, with the filter that's on once it isn't All. */
export const filterLabel = (filter: Filter): string => (filter === "all" ? "Filter Chats" : `Filter Chats, ${CHOICES.find((c) => c.id === filter)?.title ?? ""}`);

export type LinkTone = "live" | "busy" | "down";

/** How the link to the hub is, in the avatar's dot: green live, orange while it dials, grey once it can't. */
export const linkTone = (phase: HubState["phase"]): LinkTone => (phase === "live" ? "live" : phase === "connecting" || phase === "retrying" ? "busy" : "down");

export const linkWords = (phase: HubState["phase"]): string =>
  phase === "live" ? "Connected" : phase === "connecting" ? "Connecting…" : phase === "retrying" ? "Reconnecting…" : phase === "refused" ? "Key refused" : "Not connected";

/**
 * The avatar at the top left: the person's first initial (the hub's before it says who they are, and on a hub before
 * people), and VoiceOver's words for it, which say it opens Settings and how the link is.
 */
export const meAvatar = (meName: string | undefined, hubName: string, phase: HubState["phase"]): { readonly initial: string; readonly tone: LinkTone; readonly label: string } => {
  const name = (meName ?? "").trim() === "" ? hubName : (meName ?? "");
  const initial = [...name.trim()][0]?.toLocaleUpperCase() ?? "";
  return { initial, tone: linkTone(phase), label: `Settings, ${linkWords(phase)}` };
};
