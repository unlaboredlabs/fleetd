// A chat's file opened or saved on this computer: main reads it from the hub itself (attachment_get, in pieces that
// resume after a drop: shared/transfer.ts), so its bytes never cross to the page, and keeps it under a name of its type
// (shared/files.ts), so opening it never runs it. A picture is saved the same way, straight to the Downloads folder, or
// copied to the clipboard.

import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, clipboard, ClipboardItem, dialog, nativeImage, shell, type WebContents } from "electron";

import { numberedName, openedFileName, safeFileName } from "../shared/files";
import { readFile, type Wait } from "../shared/transfer";
import type { CallOutcome, DownloadOutcome, OpenOutcome } from "../shared/hub";
import type { FileRequest } from "../shared/ipc";

type Call = (tool: string, input: unknown) => Promise<CallOutcome>;

type Got = { readonly ok: true; readonly name: string; readonly mime: string; readonly bytes: Buffer } | { readonly ok: false; readonly message: string };

const read = async (call: Call, request: FileRequest, wait?: Wait): Promise<Got> => {
  const got = await readFile((tool, input) => call(tool, input), { projectRef: request.projectRef, attachmentId: request.attachmentId }, undefined, wait);
  if (!got.ok) return { ok: false, message: `The file couldn't be read: ${got.message}` };
  const out = got.file as { name?: unknown; mime?: unknown; dataB64?: unknown };
  if (typeof out.name !== "string" || typeof out.mime !== "string" || typeof out.dataB64 !== "string") return { ok: false, message: "The hub sent no file." };
  return { ok: true, name: safeFileName(out.name, out.mime), mime: out.mime, bytes: Buffer.from(out.dataB64, "base64") };
};

/** Opens the file in this computer's app for its type, from a folder of its own in the temp directory. */
export const openFile = async (call: Call, request: FileRequest, dir = tmpdir(), wait?: Wait): Promise<OpenOutcome> => {
  const got = await read(call, request, wait);
  if (!got.ok) return got;
  const folder = join(dir, "fleetd-files", randomBytes(8).toString("hex"));
  const path = join(folder, openedFileName(got.name, got.mime));
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

/** What this run saved to the Downloads folder: the only paths the page may ask to see in their folder. */
const downloaded = new Set<string>();

/**
 * Saves the file straight to the Downloads folder under its name, without asking: the hub's own bytes, and a number
 * added to the name when it is taken, so nothing there is ever written over.
 */
export const downloadFile = async (call: Call, request: FileRequest, dir = app.getPath("downloads"), wait?: Wait): Promise<DownloadOutcome> => {
  const got = await read(call, request, wait);
  if (!got.ok) return got;
  try {
    await mkdir(dir, { recursive: true });
    for (let n = 0; ; n++) {
      const name = numberedName(got.name, n);
      const path = join(dir, name);
      try {
        // Fails on a name that is taken, even one taken since the last look.
        await writeFile(path, got.bytes, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        // A write that stopped part way (a full disk) leaves no half of a file behind.
        await rm(path, { force: true }).catch(() => undefined);
        throw error;
      }
      downloaded.add(path);
      return { ok: true, path, name };
    }
  } catch (error) {
    return { ok: false, message: `The file couldn't be saved: ${String(error)}` };
  }
};

/** Shows a file downloadFile saved in its folder; any other path is refused. */
export const showDownloaded = (path: string): OpenOutcome => {
  if (!downloaded.has(path)) return { ok: false, message: "fleetd didn't save that file." };
  shell.showItemInFolder(path);
  return { ok: true };
};

/**
 * Puts the picture on the clipboard as a PNG of its own pixels, which is what apps paste. A PNG goes as it is; a JPEG is
 * decoded here first. A kind main can't decode (WebP and GIF, outside macOS) says so.
 */
export const copyImage = async (call: Call, request: FileRequest): Promise<OpenOutcome> => {
  const got = await read(call, request);
  if (!got.ok) return got;
  try {
    let png = got.bytes;
    if (got.mime !== "image/png") {
      const image = nativeImage.createFromBuffer(got.bytes);
      if (image.isEmpty()) return { ok: false, message: `This kind of image (${got.mime}) can't be copied. Save it instead.` };
      png = image.toPNG();
    }
    await clipboard.write([new ClipboardItem({ "image/png": new Blob([new Uint8Array(png)], { type: "image/png" }) })]);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: `The image couldn't be copied: ${String(error)}` };
  }
};
