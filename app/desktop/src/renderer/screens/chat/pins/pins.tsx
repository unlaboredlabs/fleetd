// A bot's pinned messages, the same for everyone in its chat (chat_message_pins): read once and again on each
// `chat.message_pins` (effects.ts), set from a bubble's menu. Under the chat's pill a glass capsule shows the newest
// pin's first line: with one pin it opens the chat there, with several the panel's Pinned list. Nothing shows with none.
// The list in the panel opens the chat at a pin through `goToMessage`, which the chat on screen listens to.
import { Pin } from "lucide-react";
import { useEffect, useMemo } from "react";
import type { ChatMessagePin } from "../../../../shared/contracts";
import { toast } from "../../../ui";
import { useData, useDataLayer, useToolQuery } from "../../../src/data/react";
import { projectKey, type ProjectKey } from "../../../src/data/store";
import type { ProjectRef } from "../slots";
import s from "./pins.module.css";

/** The hub feature word for search and pins: an older hub shows neither. */
export const FIND_PINS = "chat_find_pins";

export const useFindPins = (): boolean => useData((d) => d.features.includes(FIND_PINS));

const noPins: readonly ChatMessagePin[] = [];

/** The chat's pins, newest pinned first; empty until read, or on a hub without them. */
export function usePins(project: ProjectRef): readonly ChatMessagePin[] {
  const on = useFindPins();
  const q = useToolQuery("chat_message_pins", { projectRef: project }, { enabled: on });
  return q.data?.pins ?? noPins;
}

/** Pin / Unpin for the bubbles' menu: which messages are pinned, and the call. Undefined on a hub without pins. */
export function usePinActions(project: ProjectRef, pins: readonly ChatMessagePin[]) {
  const on = useFindPins();
  const layer = useDataLayer();
  return useMemo(
    () =>
      on
        ? {
            pinned: new Set(pins.map((p) => p.messageId)),
            set: (messageId: string, pinned: boolean) => {
              void layer.call("chat_message_pin", { projectRef: project, messageId, pinned }).then((r) => {
                if (!r.ok) toast({ title: pinned ? "Couldn’t pin the message" : "Couldn’t unpin the message", description: r.error.message, key: `pin:${messageId}` });
              });
            },
          }
        : undefined,
    [on, pins, layer, project],
  );
}

type GoTo = (key: ProjectKey, messageId: string) => void;
const goers = new Set<GoTo>();

/** Opens `key`'s chat on screen at message `messageId` (a pin in the panel's list). */
export const goToMessage = (key: ProjectKey, messageId: string): void => goers.forEach((g) => g(key, messageId));

/** The chat on screen hears `goToMessage` for its own bot. */
export function useGoTo(project: ProjectRef, go: (messageId: string) => void): void {
  const key = projectKey(project);
  useEffect(() => {
    const g: GoTo = (k, id) => {
      if (k === key) go(id);
    };
    goers.add(g);
    return () => {
      goers.delete(g);
    };
  }, [key, go]);
}

/** Who wrote a hit, as the chat names them. */
export function whoOf(h: Pick<ChatMessagePin, "author" | "by" | "person">, bot: string, me: string | undefined, names: ReadonlyMap<string, string>): string {
  if (h.author === "lead") return bot;
  if (h.author === "human") {
    if (h.person === undefined) return "You";
    return h.person.personId === me ? "You" : (names.get(h.person.personId) ?? h.person.name);
  }
  if (h.author === "agent") return h.by ?? "An agent";
  return "fleetd";
}

/** A hit's time: the clock today, the day this year, the date before. */
export function whenOf(iso: string, nowMs: number): string {
  const at = new Date(iso);
  const now = new Date(nowMs);
  if (at.toDateString() === now.toDateString()) return at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (at.getFullYear() === now.getFullYear()) return at.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return at.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** The capsule under the pill: the newest pin's first line, and how many there are when more than one. */
export function PinCapsule(props: { pins: readonly ChatMessagePin[]; onOpen: () => void }) {
  const newest = props.pins[0];
  if (newest === undefined) return null;
  const several = props.pins.length > 1;
  return (
    <button
      type="button"
      className={s.capsule}
      data-floats=""
      data-pins={props.pins.length}
      onClick={props.onOpen}
      aria-label={several ? `${String(props.pins.length)} pinned messages: show them` : `Pinned: ${newest.text}. Show it`}
    >
      <Pin className={s.pin} aria-hidden />
      <span className={s.text}>{newest.text || "Pinned message"}</span>
      {several ? <span className={s.count}>{props.pins.length}</span> : null}
    </button>
  );
}
