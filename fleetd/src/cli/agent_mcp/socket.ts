// The node's local socket: one frame out, one line back.
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { connect } from "node:net";
import { fleetdDir } from "../../shared/home.ts";
import { isObject, rustJson } from "./json.ts";

/** Under the fleetd dir. */
export const NODE_SOCKET_PATH = "node/node.sock";

export const nodeSocketPath = (envSock: string | undefined) =>
  envSock ? envSock : join(fleetdDir(), NODE_SOCKET_PATH);

// Rust's `io::Error` Display for the errors a connect or a read meets: `strerror` and the errno.
const OS_ERRORS: Record<string, [string, number]> = {
  EPERM: ["Operation not permitted", 1],
  ENOENT: ["No such file or directory", 2],
  EACCES: ["Permission denied", 13],
  ENOTDIR: ["Not a directory", 20],
  EISDIR: ["Is a directory", 21],
  ENAMETOOLONG: ["File name too long", 36],
  ELOOP: ["Too many levels of symbolic links", 40],
  ENOTSOCK: ["Socket operation on non-socket", 88],
  EPROTOTYPE: ["Protocol wrong type for socket", 91],
  ECONNRESET: ["Connection reset by peer", 104],
  ECONNREFUSED: ["Connection refused", 111],
  EPIPE: ["Broken pipe", 32],
};

/** An error as Rust's `io::Error` prints it: "No such file or directory (os error 2)". */
export function osError(error: unknown): string {
  const code = (error as { code?: string }).code;
  const known = code ? OS_ERRORS[code] : undefined;
  return known ? `${known[0]} (os error ${known[1]})` : String((error as Error).message ?? error);
}

/** The working directory as the caller's shell names it. The node keeps workspace roots as written, symlinks
 * included, and starts agents there, so the shell's logical `PWD` matches a root where the resolved path may not. */
export function callerCwd(pwd: string | undefined, physical: string): string {
  if (!pwd?.startsWith("/")) return physical;
  try {
    return realpathSync(pwd) === realpathSync(physical) ? normalize(pwd) : physical;
  } catch {
    return physical;
  }
}

/** `path.normalize` for an absolute path: `.` and `..` resolved lexically, a trailing slash kept. */
function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  const out = `/${parts.join("/")}`;
  return path.endsWith("/") && out !== "/" ? `${out}/` : out;
}

/** The node's answer, checked against the contract: a `lead_result` or `browser_result` with an id and exactly one
 * of result and error, or `held`. Anything else is a frame this CLI cannot read. */
function decodeResultFrame(line: string): Record<string, unknown> | undefined {
  let frame: unknown;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  if (!isObject(frame)) return;
  if (frame.t === "held") return Number.isInteger(frame.steps) && (frame.steps as number) >= 0 ? frame : undefined;
  if (frame.t !== "lead_result" && frame.t !== "browser_result") return;
  if (typeof frame.id !== "string" || frame.id === "") return;
  const result = frame.result ?? null;
  const error = frame.error ?? null;
  if ((result === null) === (error === null)) return;
  if (result !== null && !(isObject(result) && typeof result.op === "string")) return;
  if (error !== null && !(isObject(error) && typeof error.code === "string" && typeof error.message === "string")) return;
  return frame;
}

/** How long a call waits for the node's socket to listen again: a node restarting for an update is back within
 * seconds. Nothing was sent yet, so retrying the connect can't run a call twice. */
const CONNECT_WAIT_MS = 20_000;
const CONNECT_RETRY_MS = 250;
/** Why a call failed when no node listened within CONNECT_WAIT_MS. */
export const NODE_RESTARTING = "fleetd is restarting; try again";

/** One frame out, one frame back over the node's socket, retrying the connect every CONNECT_RETRY_MS for up to
 * `connectWaitMs` while no node listens. The node answers within ~65 s; `timeoutMs` is a backstop. Throws (a string)
 * why the node could not be asked or did not answer. */
export async function sendToNode(
  socket: string,
  frame: unknown,
  timeoutMs: number,
  connectWaitMs = CONNECT_WAIT_MS,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + connectWaitMs;
  for (;;) {
    const answer = await sendOnce(socket, frame, timeoutMs);
    if (answer !== DOWN) return answer;
    const left = deadline - Date.now();
    if (left <= 0)
      throw `${NODE_RESTARTING} (no fleetd node is listening at ${socket}; set FLEETD_NODE_SOCK if it is elsewhere)`;
    await Bun.sleep(Math.min(CONNECT_RETRY_MS, left));
  }
}

/** No node listens at the socket: nothing was sent. */
const DOWN = Symbol("down");

function sendOnce(socket: string, frame: unknown, timeoutMs: number): Promise<Record<string, unknown> | typeof DOWN> {
  return new Promise((resolve, reject) => {
    let connected = false;
    let buffer = "";
    let settled = false;
    const conn = connect(socket);
    const finish = (error: string | undefined, answer?: Record<string, unknown> | typeof DOWN) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      error === undefined ? resolve(answer!) : reject(error);
    };
    const timer = setTimeout(
      () =>
        finish(
          `the fleetd node did not answer within ${Math.floor(timeoutMs / 1000)} s; the call may or may not have gone through — try again shortly`,
        ),
      timeoutMs,
    );
    conn.setEncoding("utf8");
    conn.on("connect", () => {
      connected = true;
      conn.write(`${rustJson(frame)}\n`);
    });
    conn.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const answer = decodeResultFrame(buffer.slice(0, end));
      if (answer) finish(undefined, answer);
      else finish("the fleetd node sent an answer this CLI cannot read; check that node and CLI versions match");
    });
    conn.on("end", () => finish("the fleetd node closed the connection without answering — try again shortly"));
    conn.on("close", () => finish("the fleetd node closed the connection without answering — try again shortly"));
    conn.on("error", (error: NodeJS.ErrnoException) => {
      if (!connected && (error.code === "ENOENT" || error.code === "ECONNREFUSED")) finish(undefined, DOWN);
      else finish(`cannot reach the fleetd node at ${socket}: ${osError(error)}`);
    });
  });
}
