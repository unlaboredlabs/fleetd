// Where a tapped notification leaves the app's stack: the chats list, its chat over it, and a screen's live view over
// that, as Messages and Telegram open a tapped banner, with Back to the list. Whatever was open goes (another chat, a
// sheet, Settings, a live view), so the chat never opens under a sheet or in place of another chat's screen. The chat
// already open, or a live view already watching that screen, stays as it was, its draft and place kept: only its
// params change, which land it again (`tap`).
import type { ChatAt } from "./push";
import type { Key } from "./store";

/** A route of the root stack, as the navigator's state holds it. */
export interface StackRoute {
  readonly key: string;
  readonly name: string;
  readonly params?: object | undefined;
}

/** A route to reset to: an existing one keeps its key, so its screen stays mounted. */
export interface TappedRoute {
  readonly key?: string;
  readonly name: string;
  readonly params?: object;
}

export const tappedStack = (routes: readonly StackRoute[], at: ChatAt, tap: number): { index: number; routes: TappedRoute[] } => {
  const keyed = (name: string, same: (params: Record<string, unknown>) => boolean) => routes.find((r) => r.name === name && same((r.params ?? {}) as Record<string, unknown>))?.key;
  const home = keyed("Home", () => true);
  const chat = keyed("Chat", (p) => p.key === at.key);
  const stack: TappedRoute[] = [
    { ...(home === undefined ? {} : { key: home }), name: "Home" },
    { ...(chat === undefined ? {} : { key: chat }), name: "Chat", params: { key: at.key, ...(at.requestId === undefined ? {} : { requestId: at.requestId }), tap } },
  ];
  if (at.sessionId !== undefined) {
    const screen = keyed("Screen", (p) => p.sessionId === at.sessionId);
    stack.push({ ...(screen === undefined ? {} : { key: screen }), name: "Screen", params: { key: at.key, sessionId: at.sessionId } });
  }
  return { index: stack.length - 1, routes: stack };
};

/** A notification for a chat that's gone (removed since it was sent) opens nothing, once the chats are known. */
export const tapGoesNowhere = (projects: Readonly<Record<Key, unknown>> | undefined, at: ChatAt): boolean => projects !== undefined && projects[at.key] === undefined;
