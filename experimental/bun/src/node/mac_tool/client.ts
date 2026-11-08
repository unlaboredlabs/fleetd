// The agent's side of the agents' Mac (crates/fleetd/src/node/mac_tool/client.rs, push.rs): an agent's `fleetd mac`
// comes to its node as the lead call `mac`, which this turns into sealed steps: `mac_where` names the Mac and its key,
// each step goes with `mac_send`, and only this node opens the answers. A push snapshots the worktree as git sees it
// (its own index, never the agent's) and sends only what the Mac lacks as a thin pack; a pull brings a file or a
// folder (as a tar.gz) back into the worktree.
//
// TODO(bun): simulators' agent-device forwarder on the PATH (`sim_start`), the action log of the session's runs, and
// following a background run to its end.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readdirSync, readSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { ToolError } from "../../shared/errors.ts";
import { hubCall, type Node } from "../browser/node.ts";
import { type Done, type Envelope, openAnswer, PIECE, PULL_MAX, PUSH_MAX, sealStep, type Step } from "./protocol.ts";

/** How long a step may take: a first push indexes a whole tree on the Mac. Past the hub's own wait. */
export const SEND_WAIT = 180_000;
/** Steps that do the same twice are sent again for this long while the hub or the Mac can't be reached. */
const RESEND_FOR = 300_000;

const refuse = (message: string, fix?: string) => new ToolError("invalid", message, fix);
const failed = (message: string, fix?: string) => new ToolError("failed", message, fix);

export type MacCall =
  | { op?: "mac"; step: "push" }
  | { step: "run"; args: string[]; env?: { name: string; value: string }[]; background?: boolean }
  | { step: "logs"; job: number; offset: number }
  | { step: "ps" }
  | { step: "kill"; job: number }
  | { step: "pull"; path: string; to?: string }
  | { step: "sim_start"; device?: string }
  | { step: "sim_end" };

type Mac = { machineId: string; key: Uint8Array };

const WHO = { GIT_AUTHOR_NAME: "fleetd mac", GIT_AUTHOR_EMAIL: "mac@fleetd.invalid", GIT_COMMITTER_NAME: "fleetd mac", GIT_COMMITTER_EMAIL: "mac@fleetd.invalid" };

function git(dir: string, args: string[], env: Record<string, string> = {}): string {
  const out = Bun.spawnSync(["git", "-C", dir, ...args], { env: { ...process.env, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (out.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${out.stderr.toString().trim()}`);
  return out.stdout.toString().trim();
}

/** The worktree's files as one commit, on its own index: the snapshot the Mac checks out (push.rs `snapshot`). */
export function snapshot(worktree: string, scratch: string, parent?: string): string {
  const index = join(scratch, "mac-push.index");
  const real = git(worktree, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  rmSync(index, { force: true });
  if (existsSync(real)) copyFileSync(real, index);
  const env = { GIT_INDEX_FILE: index };
  try {
    git(worktree, ["add", "--all", "."], env);
    const tree = git(worktree, ["write-tree"], env);
    if (parent) {
      try {
        if (git(worktree, ["rev-parse", `${parent}^{tree}`]) === tree) return parent;
      } catch {
        // Not a commit here.
      }
    }
    return git(worktree, ["commit-tree", tree, "-m", "fleetd mac push", ...(parent ? ["-p", parent] : [])], WHO);
  } finally {
    rmSync(index, { force: true });
  }
}

/** Of the snapshots the Mac holds, those this worktree has too: what a pack may leave out. */
export function known(worktree: string, haves: string[]): string[] {
  return haves.filter((h) => {
    if (!/^[0-9a-fA-F]{40,}$/.test(h)) return false;
    try {
      git(worktree, ["cat-file", "-e", `${h}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  });
}

/** A thin pack of `snap` without what the Mac holds. */
export function pack(worktree: string, scratch: string, snap: string, knownIds: string[]): string {
  const path = join(scratch, "mac-push.pack");
  const revs = `${snap}\n${knownIds.map((k) => `^${k}\n`).join("")}`;
  const out = Bun.spawnSync(["git", "-C", worktree, "pack-objects", "--revs", "--thin", "--stdout", "--quiet"], {
    stdin: new TextEncoder().encode(revs),
    stdout: Bun.file(path),
    stderr: "pipe",
  });
  if (out.exitCode !== 0) {
    rmSync(path, { force: true });
    throw new Error(`git pack-objects failed: ${out.stderr.toString().trim()}`);
  }
  return path;
}

/** Where a pull lands: inside the worktree only, never its `.git` or the worktree itself. */
export function destination(worktree: string, path: string, to: string | null | undefined): string {
  const leaf = path.split("/").filter(Boolean).at(-1);
  if (!leaf || leaf === "." || leaf === "..") throw refuse(`${path} names no file`);
  const named = to ?? leaf;
  const rel = isAbsolute(named) && (named === worktree || named.startsWith(`${worktree}/`)) ? relative(worktree, named) : named;
  if (isAbsolute(rel) || rel.split("/").some((p) => p === "..")) {
    throw refuse(`${named} is outside your worktree`, "name a path inside your worktree, relative to it");
  }
  let dest = join(worktree, normalize(rel));
  if (to != null && existsSync(dest) && statSync(dest).isDirectory()) dest = join(dest, leaf);
  const inner = relative(worktree, dest);
  if (inner === "" || inner === ".") throw refuse("a pull can't replace your worktree itself", "name a file or folder inside it, such as out/");
  if (inner.split(sep).includes(".git")) throw refuse(`${named} is inside .git`);
  return dest;
}

function merge(from: string, to: string): void {
  if (!existsSync(to)) return renameSync(from, to);
  if (!statSync(to).isDirectory()) throw new Error(`${to} is a file, and a folder came`);
  for (const name of readdirSync(from)) {
    const [f, t] = [join(from, name), join(to, name)];
    if (statSync(f).isDirectory()) merge(f, t);
    else if (existsSync(t) && statSync(t).isDirectory()) throw new Error(`${t} is a folder, and a file came`);
    else renameSync(f, t);
  }
}

/** A pulled piece into place: a file as it is, a folder's tar.gz unpacked and merged, never with links or `..`. */
export function place(part: string, dest: string, folder: boolean): void {
  mkdirSync(dirname(dest), { recursive: true });
  if (!folder) {
    if (existsSync(dest) && statSync(dest).isDirectory()) throw new Error(`${dest} is a folder`);
    return renameSync(part, dest);
  }
  const listed = Bun.spawnSync(["tar", "-tvzf", part], { stdout: "pipe", stderr: "pipe" });
  if (listed.exitCode !== 0) throw new Error("the folder's archive doesn't read");
  const names = Bun.spawnSync(["tar", "-tzf", part], { stdout: "pipe" }).stdout.toString().split("\n").filter(Boolean);
  const linked = listed.stdout.toString().split("\n").some((l) => l.startsWith("l") || l.startsWith("h"));
  const climbs = names.some((n) => n.startsWith("/") || n.split("/").includes(".."));
  if (linked || climbs) throw new Error("the folder's archive holds links or paths outside it");
  const unpack = mkdtempSync(join(dirname(dest), ".mac-pull-"));
  try {
    const out = Bun.spawnSync(["tar", "-xzf", part, "-C", unpack, "--no-same-owner"], { stdout: "pipe", stderr: "pipe" });
    if (out.exitCode !== 0) throw new Error(`tar failed: ${out.stderr.toString().trim()}`);
    const top = readdirSync(unpack)[0];
    if (!top) throw new Error("the folder came back empty");
    merge(join(unpack, top), dest);
  } finally {
    rmSync(unpack, { recursive: true, force: true });
  }
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

export class MacClient {
  constructor(private readonly node: Node) {}

  private async find(thread: string, cwd: string): Promise<Mac> {
    const r = await hubCall(this.node, "mac_where", {}, { threadId: thread, cwd, waitMs: SEND_WAIT });
    const key = Buffer.from(String(r.boxPubKey ?? ""), "base64");
    if (key.length !== 32) throw failed("the Mac's key is not 32 bytes");
    return { machineId: String(r.machineId), key };
  }

  /** One step, sealed to the Mac, and its answer opened, with the raw bytes after it. */
  private async send(thread: string, cwd: string, mac: Mac, step: Step, raw: Uint8Array = new Uint8Array()): Promise<[Done, Uint8Array]> {
    const answerKey = crypto.getRandomValues(new Uint8Array(32));
    const envelope: Envelope = { thread, atMs: Date.now(), nonce: b64(crypto.getRandomValues(new Uint8Array(16))), answerKey: b64(answerKey), step };
    const sealed = sealStep(mac.key, envelope, raw);
    const r = await hubCall(this.node, "mac_send", { machineId: mac.machineId, threadId: thread, sealed }, { threadId: thread, cwd, waitMs: SEND_WAIT });
    const opened = openAnswer(answerKey, String(r.sealed ?? ""));
    answerKey.fill(0);
    if (!opened) throw failed("the Mac's answer did not open", "run the command again");
    const [answer, after] = opened;
    if (answer.error) throw new ToolError(answer.error.code, answer.error.message, answer.error.fix);
    if (!answer.done) throw failed("the Mac sent an empty answer");
    return [answer.done, after];
  }

  /** `send`, again while the hub or the Mac can't be reached: only for steps that do the same twice. */
  private async sendAgain(thread: string, cwd: string, mac: Mac, step: Step, raw?: Uint8Array): Promise<[Done, Uint8Array]> {
    const started = Date.now();
    let wait = 1000;
    for (;;) {
      try {
        return await this.send(thread, cwd, mac, step, raw);
      } catch (e) {
        if (!(e instanceof ToolError) || e.code !== "machine_offline" || Date.now() - started >= RESEND_FOR) throw e;
        await Bun.sleep(wait);
        wait = Math.min(wait * 2, 15_000);
      }
    }
  }

  /** The agent's `fleetd mac` call, for its session `thread`, from its worktree `worktree`. */
  async call(thread: string, worktree: string, call: MacCall): Promise<Record<string, unknown>> {
    const mac = await this.find(thread, worktree);
    const one = async <S extends Done["step"]>(step: Step, want: S) => {
      const [done] = await this.send(thread, worktree, mac, step);
      if (done.step !== want) throw failed(`the Mac answered ${want} with another step's`);
      return done as Extract<Done, { step: S }>;
    };
    switch (call.step) {
      case "push":
        return this.push(thread, worktree, mac);
      case "run": {
        const done = await one({ step: "run", args: call.args, env: call.env ?? [], background: call.background ?? false }, "run");
        return { step: "run", job: done.job };
      }
      case "logs": {
        const { step: _, ...rest } = await one({ step: "logs", job: call.job, offset: call.offset }, "logs");
        return { step: "logs", ...rest };
      }
      case "ps":
        return { step: "ps", jobs: (await one({ step: "ps" }, "ps")).jobs };
      case "kill": {
        const done = await one({ step: "kill", job: call.job }, "kill");
        return { step: "kill", job: done.job, killed: done.killed };
      }
      case "pull":
        return this.pull(thread, worktree, mac, call.path, call.to);
      case "sim_start": {
        const done = await one({ step: "sim_start", ...(call.device ? { device: call.device } : {}) }, "sim_start");
        return { step: "sim_start", udid: done.udid, device: done.device };
      }
      case "sim_end":
        return { step: "sim_end", ended: (await one({ step: "sim_end" }, "sim_end")).ended };
      default:
        throw refuse(`fleetd mac doesn't know ${(call as { step?: string }).step}`);
    }
  }

  private scratch(thread: string): string {
    const dir = join(this.node.home, "tmp", `mac-${thread.slice(0, 12).replace(/[^A-Za-z0-9-]/g, "")}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private async push(thread: string, worktree: string, mac: Mac): Promise<Record<string, unknown>> {
    const scratch = this.scratch(thread);
    const [have] = await this.sendAgain(thread, worktree, mac, { step: "have" });
    if (have.step !== "have") throw failed("the Mac answered have with another step's");
    let snap: string;
    let knownIds: string[];
    try {
      knownIds = known(worktree, have.snapshots);
      snap = snapshot(worktree, scratch, knownIds[0]);
    } catch (e) {
      throw failed(`the worktree's snapshot wasn't made: ${(e as Error).message}`);
    }
    let sent = 0;
    let packName: string | undefined;
    if (!knownIds.includes(snap)) {
      let path: string;
      try {
        path = pack(worktree, scratch, snap, knownIds);
      } catch (e) {
        throw failed(`the push's pack wasn't made: ${(e as Error).message}`);
      }
      try {
        sent = await this.put(thread, worktree, mac, path, have.raw);
      } finally {
        rmSync(path, { force: true });
      }
      packName = "push.pack";
    }
    const [done] = await this.sendAgain(thread, worktree, mac, { step: "checkout", snapshot: snap, ...(packName ? { pack: packName } : {}) });
    if (done.step !== "checkout") throw failed("the Mac answered checkout with another step's");
    return { step: "push", folder: done.folder, sentBytes: sent };
  }

  private async put(thread: string, worktree: string, mac: Mac, path: string, raw: boolean): Promise<number> {
    const total = statSync(path).size;
    if (total > PUSH_MAX) {
      throw refuse(
        `the push is ${total >> 20} MB, more than the Mac takes (${PUSH_MAX >> 20} MB)`,
        "add what doesn't belong (build output, downloads) to .gitignore and push again",
      );
    }
    const fd = openSync(path, "r");
    try {
      let offset = 0;
      for (;;) {
        const piece = Buffer.alloc(Math.min(PIECE, total - offset));
        if (piece.length > 0) readSync(fd, piece, 0, piece.length, offset);
        const last = piece.length === 0 || offset + piece.length >= total;
        const step: Step = { step: "put", name: "push.pack", offset, dataB64: raw ? "" : piece.toString("base64") };
        const [done] = await this.sendAgain(thread, worktree, mac, step, raw ? piece : undefined);
        if (done.step !== "put") throw failed("the Mac answered put with another step's");
        offset = done.bytes;
        if (last) return offset;
      }
    } finally {
      closeSync(fd);
    }
  }

  private async pull(thread: string, worktree: string, mac: Mac, path: string, to: string | undefined): Promise<Record<string, unknown>> {
    const dest = destination(worktree, path, to);
    const part = join(this.scratch(thread), "pull.part");
    const fd = openSync(part, "w");
    let offset = 0;
    let folder = false;
    let restarted = false;
    try {
      for (;;) {
        let done: Done;
        let raw: Uint8Array;
        try {
          [done, raw] = await this.sendAgain(thread, worktree, mac, { step: "get", path, offset, raw: true });
        } catch (e) {
          // A folder's last piece asked for again: the Mac let its tar.gz go once it sent it, so it comes again, once.
          if (e instanceof ToolError && e.code !== "machine_offline" && folder && offset > 0 && !restarted) {
            restarted = true;
            offset = 0;
            continue;
          }
          throw e;
        }
        if (done.step !== "get") throw failed("the Mac answered get with another step's");
        folder = done.folder;
        const data = done.dataB64 === "" ? raw : Buffer.from(done.dataB64, "base64");
        if (done.total > PULL_MAX || offset + data.length > PULL_MAX) throw refuse("the pull is larger than the node takes");
        writeSync(fd, data, 0, data.length, offset);
        offset += data.length;
        if (offset >= done.total || data.length === 0) break;
      }
    } finally {
      closeSync(fd);
    }
    try {
      place(part, dest, folder);
    } catch (e) {
      throw failed(`the pull wasn't placed: ${(e as Error).message}`);
    } finally {
      rmSync(part, { force: true });
    }
    return { step: "pull", path: dest, bytes: offset };
  }
}
