// `vault_store`: a secret the agent holds, saved as its bot's vault variable without the value entering the
// transcript. The agent writes it to a 0600 file and names the file; this server (fleetd's, in the session, not the
// model) reads it, seals it to the workspace's box key, sends only the sealed value, then overwrites and deletes the
// file. The agent gets back the name and a fingerprint. Nothing hands the value back to an agent.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, sep } from "node:path";
import { seal } from "../../shared/sealed_box.ts";
import { type LeadDeps, sendCall } from "./index.ts";
import { at } from "./json.ts";
import { errorResult, toolResult, type ToolResult } from "./results.ts";
import { callerCwd, osError } from "./socket.ts";

/** The largest file `vault_store` takes. */
export const STORE_MAX_BYTES = 64 * 1024;

type Call = Record<string, unknown>;

const inside = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

function real(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** The file's text, once it passes every check; thrown, why not. The fd is opened without following a symlink and
 * checked as opened, so the file read is the file checked. */
export function readSecretFile(path: string, roots: string[]): Buffer {
  if (!path.startsWith("/")) throw `${path} isn't an absolute path.`;
  const dir = real(dirname(path));
  const allowed = roots.map(real).filter((r): r is string => r !== undefined);
  if (dir === undefined || !allowed.some((root) => inside(dir, root))) {
    throw `${path} is outside your worktree and TMPDIR: write the file in one of them.`;
  }
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    throw (error as { code?: string }).code === "ELOOP" ? `${path} is a symlink: name the file itself.` : `Can't read ${path}: ${osError(error)}.`;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw `${path} isn't a regular file.`;
    if ((st.mode & 0o777) !== 0o600) throw `${path} is mode ${(st.mode & 0o777).toString(8).padStart(3, "0")}: make it 0600 (chmod 600) first.`;
    if (process.getuid !== undefined && st.uid !== process.getuid()) throw `${path} isn't yours.`;
    if (st.size === 0) throw `${path} is empty.`;
    if (st.size > STORE_MAX_BYTES) throw `${path} is over ${STORE_MAX_BYTES / 1024} KB.`;
    const bytes = Buffer.alloc(st.size);
    let got = 0;
    while (got < bytes.length) {
      const n = readSync(fd, bytes, got, bytes.length - got, got);
      if (n === 0) break;
      got += n;
    }
    return bytes.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

/** The variable's value: the file's UTF-8 text, one trailing newline dropped (as `$(cat file)` would). */
export function valueOf(bytes: Buffer): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw "The file isn't UTF-8 text: a variable holds text (base64 a binary key first).";
  }
  if (text.includes("\0")) throw "The file holds a NUL byte, which no variable can.";
  text = text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : text;
  if (text === "") throw "The file holds only a newline.";
  return text;
}

/** Overwrites the file with zeros, flushes, then deletes it. */
export function shred(path: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW);
  try {
    const size = fstatSync(fd).size;
    const zeros = Buffer.alloc(Math.min(size, STORE_MAX_BYTES));
    for (let at = 0; at < size; at += zeros.length) writeSync(fd, zeros, 0, Math.min(zeros.length, size - at), at);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  unlinkSync(path);
}

/** `vault_store`: checks the file, asks the workspace for its box key, sends the sealed value, shreds the file. */
export async function storeSecret(call: Call, deps: LeadDeps): Promise<ToolResult> {
  const name = String(call.name);
  const file = String(call.file);
  const roots = [callerCwd(deps.pwd, deps.cwd), deps.cwd, deps.tmp ?? tmpdir()];
  let bytes: Buffer;
  let value: string;
  try {
    bytes = readSecretFile(file, roots);
    value = valueOf(bytes);
  } catch (why) {
    return errorResult(`Not stored: ${String(why)}`);
  }
  const plain = Buffer.from(value, "utf8");
  const fingerprint = createHash("sha256").update(plain).digest("hex").slice(0, 8);
  const kept = (answer: Record<string, unknown>) =>
    errorResult(`${String(toolResult(answer).content[0]!.text)}\n${file} is kept: fix it and try again, or delete it.`);
  try {
    let answer: Record<string, unknown>;
    try {
      // First the box key (nothing is stored), then the sealed value.
      answer = await sendCall({ op: "vault_store", name }, deps);
      if (!("result" in answer)) return kept(answer);
      const sealTo = at(answer.result, "sealTo");
      if (typeof sealTo !== "string") return errorResult(`Not stored: the workspace sent no key to seal to. ${file} is kept.`);
      const sealed = Buffer.from(seal(new Uint8Array(Buffer.from(sealTo, "base64")), plain)).toString("base64");
      answer = await sendCall({ op: "vault_store", name, sealed, ...(typeof call.note === "string" ? { note: call.note } : {}) }, deps);
    } catch (unreachable) {
      return errorResult(`Not stored: ${String(unreachable)}. ${file} is kept: try again.`);
    }
    if (!("result" in answer)) return kept(answer);
    if (at(answer.result, "fingerprint") !== fingerprint) {
      return errorResult(`The workspace stored ${name} with another fingerprint than the file's: ${file} is kept. Say so in your result.`);
    }
  } finally {
    plain.fill(0);
    bytes.fill(0);
  }
  try {
    shred(file);
  } catch (error) {
    return errorResult(`Stored ${name} (fingerprint ${fingerprint}), but ${file} wasn't deleted: ${osError(error)}. Delete it yourself.`);
  }
  return {
    content: [{ type: "text", text: `Stored ${name} in this bot's vault (fingerprint ${fingerprint}); ${file} is shredded and deleted.` }],
    isError: false,
  };
}
