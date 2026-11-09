// A node answer as an MCP tool result (`tool_result`).
import { HUB_UNREACHABLE } from "../../node/lead/index.ts";
import { at, display, isObject, rustJson } from "./json.ts";

export type ToolResult = { content: Record<string, unknown>[]; isError: boolean };

const text = (words: string, isError: boolean): ToolResult => ({ content: [{ type: "text", text: words }], isError });

export const errorResult = (words: string) => text(words, true);

/** `value.as_str().unwrap_or_default()`. */
const str = (value: unknown) => (typeof value === "string" ? value : "");

const files = (result: unknown) => {
  const list = at(result, "files");
  return (Array.isArray(list) ? list : [])
    .map((f) => at(f, "file"))
    .filter((f): f is string => typeof f === "string")
    .join(", ");
};

const note = (result: unknown) => {
  const words = at(result, "note");
  return typeof words === "string" ? ` Note: ${words}.` : "";
};

/** A browser call's answer, in words that tell the agent what to do next. */
export function browserResult(answer: Record<string, unknown>): ToolResult {
  const result = answer.result;
  const op = at(result, "op");
  const id = str(at(result, "sessionId"));
  const startMs = display(at(result, "startMs"));
  const kind = at(result, "kind");
  const desktop = at(result, "desktop");
  if (op === "session_start" && typeof at(result, "udid") === "string") {
    return text(
      `iOS session ${id} is open (${startMs} ms): a fresh iOS simulator, thrown away at session_end, recorded. Drive it ` +
        "with agent-device in Bash; it is already pointed at this simulator, so pass no --udid or --platform. " +
        "Start with `agent-device open <app>` (`agent-device open com.apple.Preferences` for Settings); its " +
        "first command takes longer while its test runner starts. End it with session_end when done.",
      false,
    );
  }
  if (op === "session_start" && typeof at(result, "serial") === "string") {
    return text(
      `Android session ${id} is open (${startMs} ms): a fresh Android emulator, thrown away at session_end, recorded. ` +
        "Drive it with agent-device in Bash; it is already pointed at this emulator, so pass no --serial or " +
        "--platform. Start with `agent-device open <app>` (`agent-device open settings`). End it with " +
        "session_end when done.",
      false,
    );
  }
  if (op === "session_start" && desktop === "mac") {
    const held = at(result, "heldBy");
    const holding =
      typeof held === "string"
        ? `You only observe for now: ${held}. screenshot, cursor_position, wait and agent-desktop's reading ` +
          "commands (snapshot, find, get, is, list-apps) work; your first other action takes the screen once " +
          "it's free."
        : "It is yours until you end it.";
    return text(
      `Mac screen session ${id} is open: the agents' Mac's own screen, shared by every agent that uses the Mac, ` +
        `recorded. ${holding} Drive it with the desktop tool: a screenshot first, then agent_desktop for apps' ` +
        "accessibility refs (`skills get platform` loads its Mac guide), clicks and keys for the rest. What " +
        "agent-desktop launches with --cdp listens on the Mac's own loopback, not yours, and closes when the " +
        "session ends; apps you open stay open on the Mac. Never type a secret there. It ends after 5 minutes " +
        "without an action; end it with session_end when done.",
      false,
    );
  }
  if (op === "session_start" && typeof desktop === "string") {
    const worktree = at(result, "worktree");
    const where =
      desktop === "container" && typeof worktree === "string"
        ? `in a container of its own; your worktree ${worktree} is in it read-only, so build on your ` +
          "machine and launch from there; write in /home/desktop or /tmp, which go with the container"
        : desktop === "container"
          ? "in a container of its own, without your worktree; write in /home/desktop or /tmp, which go with the " +
            "container"
          : "on a display of its own, with a fresh home directory";
    return text(
      `Desktop session ${id} is open (${startMs} ms): a fresh Linux desktop (${where}), thrown away at session_end, ` +
        "recorded. Drive it with the desktop tool: start with a screenshot, launch apps with action launch. End it " +
        "with session_end when done.",
      false,
    );
  }
  if (op === "desktop") {
    const content: Record<string, unknown>[] = [];
    const jpeg = at(result, "jpegB64");
    if (typeof jpeg === "string") content.push({ type: "image", data: jpeg, mimeType: "image/jpeg" });
    content.push({ type: "text", text: str(at(result, "message")) });
    return { content, isError: false };
  }
  if (op === "session_end" && kind === "mac") {
    return text(
      `Mac screen session ${id} ended, and the Mac's screen is free for the next agent; what you opened stays on ` +
        `it. Its recording (${files(result)}) goes to the hub.`,
      false,
    );
  }
  if (op === "session_end" && kind === "linux_desktop") {
    return text(
      `Desktop session ${id} ended; the desktop and everything on it are gone. Its recording (${files(result)}) goes ` +
        `to the hub.${note(result)}`,
      false,
    );
  }
  if (op === "session_end" && (kind === "android" || kind === "ios")) {
    const ios = kind === "ios";
    return text(
      `${ios ? "iOS" : "Android"} session ${id} ended; the ${ios ? "simulator" : "emulator"} and everything done in ` +
        `it are gone. Its recording (${files(result)}) goes to the hub.${note(result)}`,
      false,
    );
  }
  if (op === "session_start") {
    return text(
      `Browser session ${id} is open (${startMs} ms): a Chrome of your own, recorded. Drive it with ` +
        "agent-browser in Bash; it is already pointed at this session. If you haven't yet, run `agent-browser " +
        "skills get core` once for how. End it with session_end when done.",
      false,
    );
  }
  if (op === "session_end") {
    return text(
      `Browser session ${id} ended; the browser and its profile are gone. Its recording (${files(result)}) goes to ` +
        `the hub.${note(result)}`,
      false,
    );
  }
  const message = at(result, "message");
  if (typeof op === "string" && typeof message === "string") return text(message, false);
  return toolResult(answer);
}

/** A node answer frame as an MCP tool result: compact JSON, since it stays in the caller's context for every later
 * request. A task frame (`spawn_agent`, `message_agent`, `stop_agent`) leaves out the task's prompt, which the lead
 * just wrote. */
export function toolResult(answer: Record<string, unknown>): ToolResult {
  if ("result" in answer) {
    let result = answer.result;
    const task = at(result, "task");
    if (isObject(result) && isObject(task)) {
      const { prompt: _, ...rest } = task;
      result = { ...result, task: rest };
    }
    return text(rustJson(result), false);
  }
  const error = answer.error;
  const message = at(error, "message");
  const said = typeof message === "string" ? message : "the hub refused the call";
  // The node couldn't reach a restarting hub: nothing refused the call.
  let words = said === HUB_UNREACHABLE ? said : `Refused: ${said}`;
  const fix = at(error, "fix");
  if (typeof fix === "string") words += `\nNext: ${fix}`;
  return text(words, true);
}
