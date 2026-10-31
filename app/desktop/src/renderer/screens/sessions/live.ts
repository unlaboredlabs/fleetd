// A live session as the hub streams it (contracts app.rs, browser.rs): the window watches one session at a time
// (browser_watch, kept by main across reconnects) and shows its newest frame (browser_frame); a person takes it over
// and hands it back with browser_control; while it is theirs, their mouse, keys and pastes in the frame go to the page
// as browser_input, in the frame's own pixels. ⌘⇧↩ never does: the app's keymap catches it before the page's handlers.
import { useEffect, useRef, type ClipboardEvent, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";
import type { BrowserFrame, BrowserInput, BrowserSessionsOutput } from "../../../shared/contracts";
import type { DataLayer } from "../../src/data/queries";
import { useData, useDataLayer } from "../../src/data/react";
import { screenMark } from "./timing";

/** The newest frame of the last few sessions shown: a view that comes back shows its page at once, then live again. */
const shown = new Map<string, BrowserFrame>();
const KEEP = 8;

/**
 * The session's newest frame while this view shows it: the window watches it from mount to unmount. Until the first
 * live one comes, the last one this window showed of it, if any.
 */
export function useLiveFrame(sessionId: string, on: boolean): BrowserFrame | undefined {
  const { hub } = useDataLayer();
  useEffect(() => {
    if (!on) return undefined;
    screenMark("view", sessionId);
    void window.fleetd.hub.watch(hub, sessionId);
    screenMark("watch", sessionId);
    return () => void window.fleetd.hub.watch(hub, null);
  }, [hub, sessionId, on]);
  const frame = useData((st) => (on && st.browserFrame?.sessionId === sessionId ? st.browserFrame : undefined));
  const first = frame !== undefined;
  useEffect(() => {
    if (first) screenMark("frame", sessionId);
  }, [first, sessionId]);
  useEffect(() => {
    if (frame === undefined) return;
    shown.delete(sessionId);
    shown.set(sessionId, frame);
    for (const old of shown.keys()) if (shown.size > KEEP) shown.delete(old);
  }, [frame, sessionId]);
  return frame ?? (on ? shown.get(sessionId) : undefined);
}

/**
 * Takes the session over (`human`) or hands it back (`agent`); the hub answers with the session as it now is, which
 * replaces it in the list at once (its browser.session event reads the list again anyway).
 */
export async function setControl(layer: DataLayer, sessionId: string, control: "human" | "agent"): Promise<boolean> {
  const outcome = await layer.call("browser_control", { sessionId, control });
  if (!outcome.ok) return false;
  const now = outcome.output.session;
  layer.queryClient.setQueriesData<BrowserSessionsOutput>({ queryKey: ["call", "browser_sessions"] }, (old) =>
    old === undefined ? old : { ...old, sessions: old.sessions.map((s) => (s.sessionId === now.sessionId ? now : s)) },
  );
  return true;
}

/** CDP's modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export const modifiersOf = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number =>
  (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

const BUTTONS = ["left", "middle", "right"] as const;

/** Where a point on the shown frame is in the frame's own pixels. */
export const framePoint = (clientX: number, clientY: number, box: { left: number; top: number; width: number; height: number }, frame: { width: number; height: number }) => ({
  x: Math.round(((clientX - box.left) / Math.max(1, box.width)) * frame.width),
  y: Math.round(((clientY - box.top) / Math.max(1, box.height)) * frame.height),
});

/** ⌘V on macOS, Ctrl+V elsewhere (Shift too, as a plain-text paste): a paste, not a key for the page. */
export const isPaste = (e: { key: string; code: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean }, platform: string): boolean => {
  const mod = platform === "darwin" ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return mod && !e.altKey && (e.code === "KeyV" || e.key.toLowerCase() === "v");
};

/** A key as the page should get it; a printable one carries its text. */
export const keyInput = (e: { key: string; code: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }, action: "down" | "up"): BrowserInput => ({
  kind: "key",
  action,
  key: e.key,
  ...(e.code === "" ? {} : { code: e.code }),
  // A printable key types its character; with Ctrl or ⌘ it is a shortcut in the page, not text.
  ...(action === "down" && /^.$/u.test(e.key) && !e.ctrlKey && !e.metaKey ? { text: e.key } : {}),
  modifiers: modifiersOf(e),
});

/**
 * The handlers that send a person's input from the frame to the page while `enabled` (the page is theirs): presses,
 * releases and moves (one a frame), wheel, keys and pastes, each in the frame's pixels.
 */
export function useFrameInput(sessionId: string, frame: { width: number; height: number } | undefined, enabled: boolean) {
  const pending = useRef<BrowserInput | null>(null);
  const raf = useRef<number | undefined>(undefined);
  useEffect(() => () => {
    if (raf.current !== undefined) cancelAnimationFrame(raf.current);
  }, []);
  const { hub } = useDataLayer();
  if (!enabled || frame === undefined) return undefined;
  const send = (input: BrowserInput) => void window.fleetd.hub.input(hub, sessionId, input);
  const at = (e: PointerEvent<HTMLElement> | WheelEvent<HTMLElement>) => framePoint(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect(), frame);
  const button = (n: number) => BUTTONS[n] ?? "none";
  return {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      e.currentTarget.focus();
      send({ kind: "mouse", action: "pressed", ...at(e), button: button(e.button), clickCount: e.detail === 2 ? 2 : 1, modifiers: modifiersOf(e) });
    },
    onPointerUp: (e: PointerEvent<HTMLElement>) =>
      send({ kind: "mouse", action: "released", ...at(e), button: button(e.button), clickCount: e.detail === 2 ? 2 : 1, modifiers: modifiersOf(e) }),
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      // One move a frame at most: the newest replaces any not sent yet.
      pending.current = { kind: "mouse", action: "moved", ...at(e), button: (e.buttons & 1) === 1 ? "left" : "none", modifiers: modifiersOf(e) };
      raf.current ??= requestAnimationFrame(() => {
        raf.current = undefined;
        if (pending.current !== null) send(pending.current);
        pending.current = null;
      });
    },
    onWheel: (e: WheelEvent<HTMLElement>) => send({ kind: "mouse", action: "wheel", ...at(e), deltaX: e.deltaX, deltaY: e.deltaY, modifiers: modifiersOf(e) }),
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      // ⌘V (Ctrl+V) pastes: left alone, it becomes the paste event below, which sends this computer's clipboard. As a
      // key, it would paste the remote browser's own clipboard, which is empty.
      if (isPaste(e, window.fleetd.platform)) return;
      // The page has the keys: none of them moves focus or scrolls the app.
      e.preventDefault();
      send(keyInput(e, "down"));
    },
    onKeyUp: (e: KeyboardEvent<HTMLElement>) => {
      if (isPaste(e, window.fleetd.platform)) return;
      e.preventDefault();
      send(keyInput(e, "up"));
    },
    onPaste: (e: ClipboardEvent<HTMLElement>) => {
      const text = e.clipboardData.getData("text/plain");
      e.preventDefault();
      if (text !== "") send({ kind: "text", text: text.slice(0, 10_000) });
    },
    onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
  };
}
