// `browser_download_send`: a person puts a file a screen's browser downloaded in the bot's chat, from the screen's card.
// The session lists what its browser downloaded (`downloads`, from its node: node/browser/downloads.ts); the hub reads
// the one named from the machine the screen ran on, a piece at a time (`read_download`, which reads only that session's
// own downloads folder and only a file the chat takes), stores it as the person's own upload and sends it in the chat
// as theirs (`chat_send`, with the file attached and no words), exactly as if they had attached it: the lead gets it as
// any file of theirs. The node keeps the files a day after the screen ends; past that, or with its machine away, the
// call says so.
import { appendFile } from "node:fs/promises";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ATTACHMENT_MAX_BYTES, type BrowserDownloadSendInput, type BrowserDownloadSendOutput } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { isHuman, requireRole } from "../api/grants.ts";
import type { Caller } from "../api/registry.ts";
import { allows } from "../auth/index.ts";
import { send } from "../chat/flow.ts";
import { ExecutorError, executors } from "../executor/index.ts";
import { fromExecutor } from "../executor/tools.ts";
import { dir, safeName, store } from "../intake/attachments.ts";
import { fits } from "../intake/mime.ts";
import { runsOn } from "./live.ts";
import { get } from "./store.ts";

const notFound = (id: string) => new ToolError("not_found", `No screen ${id}.`, "Call browser_sessions for the bot's screens.");

/** A piece is at most 8 MiB: a minute is room for it on a slow link. */
const PIECE_WAIT = 60_000;

export async function browserDownloadSend(hub: Hub, caller: Caller, input: BrowserDownloadSendInput): Promise<BrowserDownloadSendOutput> {
  const id = input.sessionId;
  const session = get(hub, id);
  if (!session) throw notFound(id);
  const r = session.projectRef;
  if (!allows(caller, "read", r.machineId)) throw notFound(id);
  if (!isHuman(caller)) throw new ToolError("forbidden", "Only a person's device puts a screen's download in the chat.", "Use the fleetd app.");
  requireRole(caller, "operate", r.machineId);
  const listed = session.downloads?.find((d) => d.name === input.name);
  if (!listed) {
    throw new ToolError("not_found", `Screen ${id} downloaded no ${input.name}.`, "Pick a name from the session's downloads (browser_sessions).");
  }
  const machine = runsOn(hub, session);
  const root = join(dir(hub), "uploads");
  const tmp = join(root, `download-${crypto.randomUUID()}`);
  try {
    mkdirSync(root, { recursive: true });
    let have = 0;
    let head = new Uint8Array(0);
    let mime;
    for (;;) {
      let out;
      try {
        out = await executors(hub).call(machine, "read", { op: "read_download", sessionId: id, name: listed.name, offset: have }, PIECE_WAIT);
      } catch (error) {
        if (error instanceof ExecutorError && error.kind === "node_failed") {
          throw new ToolError("invalid", error.extra.nodeMessage ?? error.message, "Its machine keeps a screen's downloads a day after it ends: past that, download it again.");
        }
        throw fromExecutor(error);
      }
      if (out.kind !== "image") throw new ToolError("failed", "The screen's machine sent no file.");
      const piece = Buffer.from(out.dataB64, "base64");
      if (out.bytes > ATTACHMENT_MAX_BYTES || (piece.length === 0 && have < out.bytes)) {
        throw new ToolError("failed", `${listed.name} changed while it was read.`, "Try again in a moment.");
      }
      if (head.length < 64 * 1024) head = Buffer.concat([head, piece.subarray(0, 64 * 1024 - head.length)]);
      await appendFile(tmp, piece);
      have += piece.length;
      if (have >= out.bytes) {
        // The node checked the bytes; the hub checks what it holds again.
        if (have !== out.bytes || !fits(out.mime, head)) throw new ToolError("failed", `${listed.name} changed while it was read.`, "Try again in a moment.");
        mime = out.mime;
        break;
      }
    }
    // The person's upload, as attachment_put makes it, sent as their message: one send per screen and file.
    const stored = await store(hub, { path: tmp }, safeName(listed.name), mime, caller.keyId);
    const sent = await send(hub, caller, { projectRef: r, text: "", attachments: [stored.attachmentId], clientRequestId: `download:${id}:${listed.name}` });
    return { attachmentId: stored.attachmentId, messageId: sent.message.messageId };
  } finally {
    rmSync(tmp, { force: true });
  }
}
