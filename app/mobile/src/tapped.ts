// Where a tapped notification leaves the app's stack: the chats list, its chat over it, and a screen's live view over
// that, as Messages opens a tapped banner, with Back to the list. Whatever was open goes (another chat, a
// sheet, Settings, a live view), so the chat never opens under a sheet or in place of another chat's screen. The chat
// already open, or a live view already watching that screen, stays as it was: only its params change, which land it
// again (`tap`). The chats list keeps its own stack's state, so Back finds it as it was left (scrolled, searched). A
// chat that goes keeps what was written in it, as its draft (drafts.ts).
import type { ChatAt } from "./push";
import type { Key } from "./store";

/** A route of the root stack, as the navigator's state holds it. */
export interface StackRoute {
  readonly key: string;
  readonly name: string;
  readonly params?: object | undefined;
  /** A nested navigator's own state (the chats list's stack). */
  readonly state?: object | undefined;
}

/** A route to reset to: an existing one keeps its key and nested state, so its screen stays mounted as it was. */
export interface TappedRoute {
  readonly key?: string;
  readonly name: string;
  readonly params?: object;
  readonly state?: object;
}

/** An existing route's key and nested state, to keep. */
const keptOf = (routes: readonly StackRoute[], name: string, same: (params: Record<string, unknown>) => boolean): { key?: string; state?: object } => {
  const r = routes.find((x) => x.name === name && same((x.params ?? {}) as Record<string, unknown>));
  return r === undefined ? {} : { key: r.key, ...(r.state === undefined ? {} : { state: r.state }) };
};

export const tappedStack = (routes: readonly StackRoute[], at: ChatAt, tap: number): { index: number; routes: TappedRoute[] } => {
  const keyed = (name: string, same: (params: Record<string, unknown>) => boolean) => keptOf(routes, name, same);
  const stack: TappedRoute[] = [
    { ...keyed("Home", () => true), name: "Home" },
    { ...keyed("Chat", (p) => p.key === at.key), name: "Chat", params: { key: at.key, ...(at.requestId === undefined ? {} : { requestId: at.requestId }), tap } },
  ];
  if (at.sessionId !== undefined) {
    stack.push({ ...keyed("Screen", (p) => p.sessionId === at.sessionId), name: "Screen", params: { key: at.key, sessionId: at.sessionId } });
  }
  return { index: stack.length - 1, routes: stack };
};

/** A notification for a chat that's gone (removed since it was sent) opens nothing, once the chats are known. */
export const tapGoesNowhere = (projects: Readonly<Record<Key, unknown>> | undefined, at: ChatAt): boolean => projects !== undefined && projects[at.key] === undefined;

/** A "New sign-in" notification: Settings' Devices list over the chats list, Back to Settings, then to the list. */
export const devicesStack = (routes: readonly StackRoute[]): { index: number; routes: TappedRoute[] } => ({
  index: 1,
  routes: [
    { ...keptOf(routes, "Home", () => true), name: "Home" },
    { name: "Settings", state: { index: 1, routes: [{ name: "Settings" }, { name: "Devices" }] } },
  ],
});
