// A Navi's Telegram setup (Telegram.tsx), as plain functions: which step the person is on, the names to give
// @BotFather, and the bridge's status in words.
import type { TelegramBridge } from "../../../shared/contracts";

/** @BotFather, Telegram's bot for making bots. */
export const BOTFATHER = "https://t.me/BotFather";

/** 1 make a bot, 2 paste its token, 3 Test, 4 pair; done once an account is paired. */
export type TelegramStep = 1 | 2 | 3 | 4 | "done";

export const stepOf = (bridge: TelegramBridge | undefined): TelegramStep => {
  if (bridge === undefined) return 1;
  if (bridge.bot === undefined) return 3;
  if (bridge.paired === undefined) return 4;
  return "done";
};

/**
 * A username to ask @BotFather for: the Navi's name in Telegram's letters, ending in `bot` as Telegram wants, 5 to 32
 * characters. "Ada" → ada_fleetd_bot.
 */
export const suggestedUsername = (title: string): string => {
  const base = title
    .normalize("NFKD")
    .replace(/[^\p{ASCII}]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .replace(/^[0-9_]+/u, "");
  const head = (base === "" ? "navi" : base).slice(0, 21).replace(/_+$/u, "");
  return `${head}_fleetd_bot`;
};

export type StatusWords = { readonly tone: "success" | "quiet" | "warning" | "danger"; readonly word: string; readonly line?: string };

const clock = (at: string | undefined): string | undefined => {
  if (at === undefined) return undefined;
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
};

/** The bridge's status as a chip and, when something is wrong, one line on what and when it tries again. */
export const statusWords = (bridge: TelegramBridge, machine: string): StatusWords => {
  if (bridge.offline === true) return { tone: "quiet", word: "Offline", line: `${machine} is offline: nothing goes through until it's back.` };
  const status = bridge.status;
  if (bridge.paused || status?.state === "paused") return { tone: "quiet", word: "Paused", line: "Nothing is read or sent until you resume. What Navi says meanwhile stays here." };
  if (status === undefined) return { tone: "quiet", word: "Starting" };
  const error = status.error?.trim().replace(/\.$/u, "");
  switch (status.state) {
    case "connected":
      return { tone: "success", word: "Connected" };
    case "connecting":
      return { tone: "quiet", word: "Connecting" };
    case "retrying": {
      const again = clock(status.retryAt);
      return { tone: "warning", word: "Retrying", line: `${error ?? "Telegram didn't answer"}.${again === undefined ? "" : ` Trying again at ${again}.`}` };
    }
    case "stopped":
      return { tone: "danger", word: "Stopped", line: `${error ?? "It stopped"}.` };
    default:
      return { tone: "quiet", word: status.state };
  }
};

