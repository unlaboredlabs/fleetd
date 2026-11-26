// `vault_store`: a secret the agent holds, saved as its bot's vault variable without the value entering the
// transcript. The agent writes it to a 0600 file and names the file; this server (fleetd's, in the session, not the
// model) reads it, seals it to the workspace's box key, sends only the sealed value, then overwrites and deletes the
// file. The agent gets back the name and a fingerprint. Nothing hands the value back to an agent. A lead's file must be
// in its TMPDIR: its working directory is the person's own checkout, whose files it must never wipe.
import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, sep } from "node:path";
import { checkStoreName, fingerprintOf, STORE_MAX_BYTES, storedValue } from "../../hub/vault/fields.ts";
import { ToolError } from "../../shared/errors.ts";
import { seal } from "../../shared/sealed_box.ts";
import { type LeadDeps, sendCall } from "./index.ts";
import { at } from "./json.ts";
import { errorResult, toolResult, type ToolResult } from "./results.ts";
import { callerCwd, osError } from "./socket.ts";
import type { Role } from "./tools.ts";

export { STORE_MAX_BYTES } from "../../hub/vault/fields.ts";

type Call = Record<string, unknown>;

const inside = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

function real(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** The file's bytes, once it passes every check; thrown, why not. The fd is opened without following a symlink and
 * checked as opened, so the file read is the file checked. `where` names the roots in the refusal. */
export function readSecretFile(path: string, roots: string[], where = "your worktree and TMPDIR"): Buffer {
  if (!path.startsWith("/")) throw `${path} isn't an absolute path.`;
  const dir = real(dirname(path));
  const allowed = roots.map(real).filter((r): r is string => r !== undefined);
  if (dir === undefined || !allowed.some((root) => inside(dir, root))) {
    throw `${path} is outside ${where}: write the file there.`;
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
    // Another name for the same bytes (a hard link to a key elsewhere) would be wiped with it.
    if (st.nlink !== 1) throw `${path} has ${st.nlink} hard links: write the value to a file of its own.`;
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

/** `vault_store`: checks the name and the file, asks the workspace for its box key, sends the file's bytes sealed,
 * shreds the file. */
export async function storeSecret(call: Call, deps: LeadDeps, role: Role = "worker"): Promise<ToolResult> {
  const name = String(call.name);
  const file = String(call.file);
  const tmp = deps.tmp ?? tmpdir();
  const [roots, where] = role === "lead" ? [[tmp], "your TMPDIR"] : [[callerCwd(deps.pwd, deps.cwd), deps.cwd, tmp], "your worktree and TMPDIR"];
  let bytes: Buffer;
  let fingerprint: string;
  try {
    checkStoreName(name);
    bytes = readSecretFile(file, roots, where);
    // The value as the workspace will work it out from the same bytes, so the fingerprints agree.
    fingerprint = fingerprintOf(storedValue(bytes));
  } catch (why) {
    return errorResult(`Not stored: ${why instanceof ToolError ? [why.message, why.fix].filter(Boolean).join(" ") : String(why)}`);
  }
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
      const sealed = Buffer.from(seal(new Uint8Array(Buffer.from(sealTo, "base64")), bytes)).toString("base64");
      answer = await sendCall({ op: "vault_store", name, sealed, ...(typeof call.note === "string" ? { note: call.note } : {}) }, deps);
    } catch (unreachable) {
      return errorResult(`Not stored: ${String(unreachable)}. ${file} is kept: try again.`);
    }
    if (!("result" in answer)) return kept(answer);
    if (at(answer.result, "fingerprint") !== fingerprint) {
      return errorResult(`The workspace stored ${name} with another fingerprint than the file's: ${file} is kept. Say so in your result.`);
    }
  } finally {
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
