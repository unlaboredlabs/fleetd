// `chat_file`: a lead or task puts an image it made (a screenshot of a UI change), or any file the chat takes (a PDF, a
// CSV, a document), in its project's chat, and is told which block shows it.
// `chat_image`, its images-only forerunner, comes only from older nodes now. The hub asks the caller's own node for the
// file, which reads it only from that session's working directory, as the node started it, and only a png, jpeg, webp
// or gif by its bytes, or for `chat_file` a file whose bytes fit the type its name says. It is stored as an attachment
// `by` the project's lead (`lead:<project>`), so no person's key reads it and no other project shows it: a lead
// message's `image` or `file` block of it marks it the project's (attachments.ts `show`), and one never shown goes with
// the other unused uploads after 24 h. The node's pieces go to a file under the uploads directory, never all in memory.
import { mkdirSync, rmSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { ATTACHMENT_MAX_BYTES, type ThreadRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { ExecutorError, executors } from "../executor/index.ts";
import { fromExecutor } from "../executor/tools.ts";
import { type LeadCall, type LeadCaller, leadCalls } from "../lead_calls/index.ts";
import { dir, safeName, store } from "./attachments.ts";
import { fits, isImage, ofImage } from "./mime.ts";

export const OPS = ["chat_image", "chat_file"] as const;

export function registerLeadCalls(hub: Hub): void {
  for (const op of OPS) {
    leadCalls(hub).register(op, (caller, call) => chatImage(hub, caller, call, op === "chat_file"));
  }
}

/** The session the caller runs in, by the hub's own records: its working directory is the only place its file is read from. */
function sessionOf(hub: Hub, caller: LeadCaller): ThreadRef {
  let thread: ThreadRef | undefined;
  const r = caller.projectRef;
  if (caller.agent.kind === "lead") {
    const lead = hub.db.conn
      .query<{ thread_id: string }, [string, string]>("SELECT thread_id FROM leads WHERE machine_id = ? AND project_id = ?")
      .get(r.machineId, r.projectId);
    if (lead) thread = { machineId: r.machineId, threadId: lead.thread_id };
  } else if (caller.agent.kind === "task") {
    const n = Number(caller.agent.taskId.slice(1));
    const task = hub.db.conn
      .query<{ machine_id: string; thread_id: string | null }, [number]>("SELECT machine_id, thread_id FROM tasks WHERE n = ?")
      .get(n);
    if (task?.thread_id) thread = { machineId: task.machine_id, threadId: task.thread_id };
  } else {
    throw new ToolError("forbidden", "Only a lead or a task's agent puts an image or file in the chat.");
  }
  if (!thread) {
    throw new ToolError("not_found", "The hub knows no session of yours to read the file from.", "Call chat_file from your own session.");
  }
  return thread;
}

function refused(error: unknown, file: boolean): ToolError {
  if (error instanceof ExecutorError && error.kind === "node_failed") {
    return new ToolError(
      "invalid",
      error.extra.nodeMessage ?? error.message,
      file
        ? "Save the file (image, PDF, text or CSV, .docx, .xlsx, .pptx or zip) inside your working directory and pass its path."
        : "Save the image (png, jpeg, webp or gif) inside your working directory and pass its path.",
    );
  }
  return fromExecutor(error);
}

const changed = (path: string) => new ToolError("failed", `${path} changed while it was read.`, "Call it again once the file is written.");

async function chatImage(hub: Hub, caller: LeadCaller, call: LeadCall, file: boolean): Promise<Record<string, unknown>> {
  const path = String(call.path ?? "");
  const thread = sessionOf(hub, caller);
  const root = join(dir(hub), "uploads");
  const tmp = join(root, `read-${crypto.randomUUID()}`);
  try {
    mkdirSync(root, { recursive: true });
    let have = 0;
    let head = new Uint8Array(0);
    let name: string;
    let mime: string;
    for (;;) {
      let out;
      try {
        out = await executors(hub).call(
          thread.machineId,
          "read",
          { op: "read_image", sessionId: thread.threadId, path, offset: have, file },
          // A piece is at most 8 MiB: a minute is room for it on a slow link.
          60_000,
        );
      } catch (error) {
        throw refused(error, file);
      }
      if (out.kind !== "image") throw refused(ExecutorError.failed(thread.machineId, "read", "the node sent no image"), file);
      const piece = Buffer.from(out.dataB64, "base64");
      const total = out.bytes;
      if (total > ATTACHMENT_MAX_BYTES || (piece.length === 0 && have < total)) throw changed(path);
      if (head.length < 64 * 1024) head = Buffer.concat([head, piece.subarray(0, 64 * 1024 - head.length)]);
      await appendFile(tmp, piece);
      have += piece.length;
      if (have >= total) {
        if (have !== total) throw changed(path);
        name = out.name;
        mime = out.mime;
        break;
      }
    }
    // The node checked the bytes; the hub checks what it holds again.
    if (!(file ? fits(mime, head) : ofImage(head) === mime)) throw changed(path);
    const stored = await store(hub, { path: tmp }, safeName(name), mime, caller.by);
    // An image shows inline in an image block, anything else as a file card.
    const image = isImage(mime);
    const kind = image ? "image" : "file";
    const next =
      caller.agent.kind === "task"
        ? `Put ${stored.attachmentId} in your result for your lead to show in ${image ? "an" : "a"} ${kind} block. Unshown, it is deleted after 24 h.`
        : `Show it in your chat message with a fleetd-block {"v":1,"kind":"${kind}","attachmentId":"${stored.attachmentId}","caption":"…"}. Unshown, it is deleted after 24 h.`;
    return { attachmentId: stored.attachmentId, mime, bytes: stored.bytes, next };
  } finally {
    rmSync(tmp, { force: true });
  }
}
