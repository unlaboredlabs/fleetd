// The links fleetd's Shortcuts actions open (plugins/app-intents, Actions.swift's Links): Open Chat's
// `fleetd://chat?machine=…&project=…`, a chat, and Open Approvals' `fleetd://approvals`, Chats' Needs You list. The
// action opens the app and leaves it the link (modules/shortcut-link), cold or warm; App.tsx goes there once the chats
// are up. Parsed by hand: React Native's URL has no searchParams.
import { keyOf, type Key } from "./store";

export type ShortcutLink = { readonly t: "chat"; readonly key: Key } | { readonly t: "approvals" };

/** The place a link opens; null when it isn't one of these (a pairing link, say) or is damaged. */
export const parseShortcutLink = (text: string): ShortcutLink | null => {
  const match = /^fleetd:\/\/(chat|approvals)(?:[/?#]|$)/iu.exec(text.trim());
  if (match === null) return null;
  if (match[1]!.toLowerCase() === "approvals") return { t: "approvals" };
  const query = text.trim().split("#")[0]?.split("?").slice(1).join("?") ?? "";
  const params = new Map<string, string>();
  for (const part of query.split("&")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    try {
      params.set(decodeURIComponent(part.slice(0, at)), decodeURIComponent(part.slice(at + 1).replace(/\+/gu, " ")));
    } catch {
      return null;
    }
  }
  const machineId = params.get("machine") ?? "";
  const projectId = params.get("project") ?? "";
  return machineId === "" || projectId === "" ? null : { t: "chat", key: keyOf({ machineId, projectId }) };
};
