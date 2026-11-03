// A chat's file opened or saved on this computer: main reads it from the hub itself (attachment_get), so its bytes never
// cross to the page, and keeps it under a name of its type (shared/files.ts), so opening it never runs it.

import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserWindow, dialog, shell, type WebContents } from "electron";

import { safeFileName } from "../shared/files";
import type { CallOutcome, OpenOutcome } from "../shared/hub";
import type { FileRequest } from "../shared/ipc";

type Call = (tool: string, input: unknown) => Promise<CallOutcome>;

type Got = { readonly ok: true; readonly name: string; readonly bytes: Buffer } | { readonly ok: false; readonly message: string };

const read = async (call: Call, request: FileRequest): Promise<Got> => {
  const got = await call("attachment_get", { projectRef: request.projectRef, attachmentId: request.attachmentId });
  if (!got.ok) return { ok: false, message: `The file couldn't be read: ${got.error.message}` };
  const out = got.output as { name?: unknown; mime?: unknown; dataB64?: unknown };
  if (typeof out.name !== "string" || typeof out.mime !== "string" || typeof out.dataB64 !== "string") return { ok: false, message: "The hub sent no file." };
  return { ok: true, name: safeFileName(out.name, out.mime), bytes: Buffer.from(out.dataB64, "base64") };
};

/** Opens the file in this computer's app for its type, from a folder of its own in the temp directory. */
export const openFile = async (call: Call, request: FileRequest, dir = tmpdir()): Promise<OpenOutcome> => {
  const got = await read(call, request);
  if (!got.ok) return got;
  const folder = join(dir, "fleetd-files", randomBytes(8).toString("hex"));
  const path = join(folder, got.name);
  try {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await writeFile(path, got.bytes, { mode: 0o600 });
  } catch (error) {
    return { ok: false, message: `The file couldn't be written: ${String(error)}` };
  }
  const failed = await shell.openPath(path);
  return failed === "" ? { ok: true } : { ok: false, message: `${got.name} didn't open: ${failed}` };
};

/** Asks where to save the file, under its name; cancelled is `{ ok: true }` too: nothing to say. */
export const saveFile = async (call: Call, request: FileRequest, sender: WebContents): Promise<OpenOutcome> => {
  const got = await read(call, request);
  if (!got.ok) return got;
  const win = BrowserWindow.fromWebContents(sender);
  const options = { title: "Save file", defaultPath: got.name };
  const picked = win === null ? await dialog.showSaveDialog(options) : await dialog.showSaveDialog(win, options);
  if (picked.canceled || picked.filePath === "") return { ok: true };
  try {
    await writeFile(picked.filePath, got.bytes);
    shell.showItemInFolder(picked.filePath);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: `The file couldn't be saved: ${String(error)}` };
  }
};
