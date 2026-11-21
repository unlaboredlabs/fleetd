// `read_image`: a piece of an image or file an agent made in
// its own working directory, for the chat. The path must resolve inside that directory, the file is opened without
// following a last symlink and checked to be the one resolved, and its bytes must be what its name says
// (fleetd-contracts mcp.rs `AttachmentMime`).
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { ATTACHMENT_MAX_BYTES, type AttachmentMime } from "../../shared/contracts.ts";
import { IMAGE_PIECE_BYTES } from "../../shared/sessions.ts";
import { within } from "../sessions/file_rules.ts";
import { chatMime, HEAD_BYTES, IMAGES, ofName, refused } from "./chat_file.ts";

export { ofFile, ofImage, ofName } from "./chat_file.ts";

export type Image = { name: string; mime: AttachmentMime; bytes: number; piece: Buffer };

/** The image (or, with `file`, any file the chat takes) at `path` in `root`, and its piece from `offset`. Throws a
 * person's words for what is wrong. */
export function readImage(root: string, path: string, offset: number, file: boolean): Image {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch (error) {
    throw new Error(refused.rootUnreadable(root, (error as Error).message));
  }
  let real: string;
  try {
    // Relative to the working directory, or absolute inside it, as the tool says.
    real = realpathSync(isAbsolute(path) ? path : join(realRoot, path));
  } catch (error) {
    throw new Error(refused.unreadable(path, (error as Error).message));
  }
  if (!within(realRoot, real)) throw new Error(refused.outside(path, realRoot, file));
  const name = basename(real);
  const byName = ofName(name);
  if (!file && !(byName && IMAGES.includes(byName))) throw new Error(refused.notImageName(path));
  let fd: number;
  try {
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(refused.unreadable(path, (error as Error).message));
  }
  try {
    const opened = fstatSync(fd);
    const named = lstatSync(real);
    if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) throw new Error(refused.notPlain(path));
    const bytes = opened.size;
    if (bytes > ATTACHMENT_MAX_BYTES) throw new Error(refused.tooLarge(path, bytes, file));
    const head = Buffer.alloc(Math.min(HEAD_BYTES, bytes));
    const got = readSync(fd, head, 0, head.length, 0);
    const mime = chatMime(name, head.subarray(0, got), file);
    if (!mime) throw new Error(refused.notWhatItSays(path, file));
    const piece = Buffer.alloc(Math.max(0, Math.min(IMAGE_PIECE_BYTES, bytes - offset)));
    const read = piece.length ? readSync(fd, piece, 0, piece.length, offset) : 0;
    return { name, mime, bytes, piece: piece.subarray(0, read) };
  } finally {
    closeSync(fd);
  }
}
