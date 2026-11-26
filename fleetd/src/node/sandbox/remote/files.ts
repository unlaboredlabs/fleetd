// A hosted box's files. A hosted box shares nothing with the machine, so the node gives it what a session reads, at the
// same absolute paths as here: the agent, its tools and every path in its spec then work unchanged. The machine's
// worktree stays the agent's work between boxes: a box starts from it and gives its work back when it ends.
//
// - `prepare`: the dirs those paths live under, made the box user's (with sudo where the box's user can't).
// - `mirror`: files and dirs under the node's home that the session's launch names (its MCP config, settings, skills,
//   the order's variables, the screens' tools), packed with tar and unpacked at the same paths (`unpack`).
// - `syncIn`: the repo cloned at the checkout's path from its origin (blobs fetched as needed, with the order's GitHub
//   token), the worktree added at the same path and name, so its git dir is the same path as here and fleetd's hooks
//   and pre-push gate (worktree/hooks.ts) hold; then the machine's commits and its uncommitted work (untracked files
//   included, ignored ones not) from a bundle, and the worktree's own fleetd files from its git dir.
// - `syncOut`: the box's commits and uncommitted work back into the machine's worktree, as a bundle on top of what the
//   box started from: after each of its turns, and when it ends.
// - A bot with no repo has a plain folder, not a checkout: it goes in as a tar, and comes back over the machine's as one,
//   with what the box removed of it removed here too (`PLAIN`).
// Each piece travels over the guest's link (`BoxFs`), never through the provider's own file calls. What only runs in the
// box (`sh`, `prepare`, `unpack`) is ./box_files.ts, box side.
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { refused } from "../../actions/chat_file.ts";
import { readImage, type Image } from "../../actions/image.ts";
import { ATTACHMENT_MAX_BYTES } from "../../../shared/contracts.ts";
import { within } from "../../sessions/file_rules.ts";
import { BOX_DIR } from "./bootstrap.ts";
import { type BoxFs, q, sh, unpack } from "./box_files.ts";

export { prepare, sh, unpack, type BoxFs } from "./box_files.ts";

/** The largest bundle a box's work comes back in. */
const BUNDLE_MAX = 2 * 1024 ** 3;

/** Host git, with an environment of its own on top of the node's. */
async function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`git ${args[0]} failed: ${err.trim().slice(-400)}`);
  return out.trim();
}

const tryGit = (cwd: string, args: string[]) => git(cwd, args).catch(() => undefined);

/** The files and dirs under `under` that a launch names, in its argv and its environment's values (each part of a
 * PATH-like one), and what the environment file the agent's commands source names in turn. */
export function named(argv: string[], env: Record<string, string | undefined>, under: string[], skip: string[]): string[] {
  const out = new Set<string>();
  const beneath = (p: string, roots: string[]) => roots.some((r) => within(r, p));
  const consider = (p: string) => {
    if (!isAbsolute(p) || !beneath(p, under) || beneath(p, skip) || !existsSync(p)) return;
    out.add(p);
  };
  for (const a of argv) for (const part of a.split("=")) consider(part);
  for (const v of Object.values(env)) if (v) for (const part of v.split(":")) consider(part);
  // The order's script the env file sources at each command: `. '<path>'`.
  const envFile = env.CLAUDE_ENV_FILE;
  if (envFile && existsSync(envFile)) for (const m of readFileSync(envFile, "utf8").matchAll(/'(\/[^']+)'/g)) consider(m[1]!);
  // A path inside another named one goes with it.
  return [...out].filter((p) => ![...out].some((o) => o !== p && beneath(p, [o])));
}

/** Packs `paths` (symlinks followed, sockets left out) and unpacks them in the box at the same paths (under `root`,
 * for tests: a stand-in box on the same machine). */
export async function mirror(box: BoxFs, paths: string[], root = ""): Promise<void> {
  if (paths.length === 0) return;
  const tmp = mkdtempSync(join(tmpdir(), "fleetd-mirror-"));
  try {
    const list = join(tmp, "list");
    writeFileSync(list, paths.map((p) => relative("/", p)).join("\0"));
    const tar = join(tmp, "files.tar");
    const child = Bun.spawn(["tar", "-C", "/", "--null", "-T", list, "-chf", tar, "--warning=no-file-ignored", "--ignore-failed-read"], { stdout: "ignore", stderr: "pipe" });
    const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    // 1: some file changed while it was read, which the next mirror catches up.
    if (code !== 0 && code !== 1) throw new Error(`packing the agent's files failed: ${err.trim().slice(-300)}`);
    await unpack(box, readFileSync(tar), root);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Sends the files among `paths` to the box again each time one changes (its mtime), looked at every `everyMs` until
 * the answer is called: one send at a time, and a send that fails (the box's link down a moment) goes again at the
 * next look. `sent` is each file's mtime as it last went in; a file it lacks goes at the first look. The order's
 * variables are among them, so a GitHub token the hub renews reaches the agent's next command in the box.
 */
export function keepMirrored(
  box: BoxFs,
  paths: string[],
  everyMs: number,
  o: { sent?: Map<string, number>; failed?: (error: Error | undefined) => void; root?: string } = {},
): () => void {
  const seen = new Map(paths.filter((p) => !isDir(p)).map((p) => [p, o.sent?.get(p) ?? -1]));
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    const changed = [...seen].filter(([p, t]) => mtimeOf(p) !== t).map(([p]) => [p, mtimeOf(p)] as const);
    if (changed.length === 0) return;
    busy = true;
    mirror(box, changed.filter(([p]) => existsSync(p)).map(([p]) => p), o.root)
      .then(() => {
        for (const [p, t] of changed) seen.set(p, t);
        o.failed?.(undefined);
      })
      .catch((error: unknown) => o.failed?.(error as Error))
      .finally(() => (busy = false));
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Host tar, throwing its output's tail when it fails. */
async function tar(args: string[]): Promise<void> {
  const child = Bun.spawn(["tar", ...args], { stdout: "ignore", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`tar failed: ${err.trim().slice(-300)}`);
}

/** What `syncIn` answers for a plain folder, which `syncOut` then takes back as one: no commit is ever named so. */
export const PLAIN = "plain";

/** Whether `cwd` is a checkout (its own .git), as a bot's image reads it (../../place/image.ts). */
const isCheckout = (cwd: string) => existsSync(join(cwd, ".git"));

/** A plain folder (a bot with no repo) in the box at the same path, as it is here. The box keeps the list of what came
 * in, so that `plainOut` takes away here only what the box took away. */
async function plainIn(box: BoxFs, cwd: string, session: string, root: string): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), "fleetd-plain-"));
  try {
    const file = join(tmp, "in.tar");
    await tar(["-C", cwd, "-cf", file, "."]);
    const at = `${root}${BOX_DIR}/in-${session}.tar`;
    await box.write(at, readFileSync(file));
    const list = `${root}${BOX_DIR}/in-${session}.list`;
    await sh(
      box,
      "unpacking the bot's folder",
      `mkdir -p ${q(root + cwd)} && tar -C ${q(root + cwd)} -xf ${q(at)} --no-same-owner && tar --quoting-style=literal -tf ${q(at)} > ${q(list)}; s=$?; rm -f ${q(at)}; exit $s`,
    );
    return PLAIN;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** The box's plain folder back here: what it holds goes over this one, and what it took away of what came in goes
 * here too. What was added here meanwhile (a file the person sent the lead) stays. */
async function plainOut(box: BoxFs, cwd: string, session: string, env: Record<string, string | undefined>, root: string): Promise<void> {
  const at = `${root}${BOX_DIR}/out-${session}.tar`;
  const gone = `${root}${BOX_DIR}/out-${session}.gone`;
  const list = `${root}${BOX_DIR}/in-${session}.list`;
  const script = [
    "set -e",
    `cd ${q(root + cwd)}`,
    `tar -cf ${q(at)} .`,
    `: > ${q(gone)}`,
    `[ ! -e ${q(list)} ] || while IFS= read -r p; do [ -e "$p" ] || [ -L "$p" ] || printf '%s\n' "$p" >> ${q(gone)}; done < ${q(list)}`,
  ].join("\n");
  await sh(box, "packing the bot's folder", script, env);
  const bytes = await box.read(at, BUNDLE_MAX);
  const removed = new TextDecoder().decode(await box.read(gone, BUNDLE_MAX)).split("\n").filter(Boolean);
  const tmp = mkdtempSync(join(tmpdir(), "fleetd-plain-"));
  try {
    const file = join(tmp, "out.tar");
    writeFileSync(file, bytes);
    await tar(["-C", cwd, "-xf", file, "--no-same-owner", "--overwrite"]);
    // Deepest first, and never outside the folder.
    for (const p of removed.sort((a, b) => b.length - a.length)) {
      const path = join(cwd, p);
      if (path.startsWith(cwd + sep)) rmSync(path, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Where a session's sync refs live in the repo, apart from every other session's. */
const refs = (session: string) => `refs/fleetd/sync/${session}`;

/** The worktree's commit, and a commit of its whole working tree on top (untracked files included, ignored ones not). */
async function snapshot(cwd: string, msg: string): Promise<{ head: string; wip: string }> {
  const gitDir = await git(cwd, ["rev-parse", "--absolute-git-dir"]);
  const tmp = mkdtempSync(join(tmpdir(), "fleetd-index-"));
  try {
    const index = join(tmp, "index");
    if (existsSync(join(gitDir, "index"))) copyFileSync(join(gitDir, "index"), index);
    const env = { GIT_INDEX_FILE: index };
    const head = await git(cwd, ["rev-parse", "HEAD"]);
    await git(cwd, ["add", "-A"], env);
    const tree = await git(cwd, ["write-tree"], env);
    const wip = await git(cwd, ["-c", "user.name=fleetd", "-c", "user.email=fleetd@localhost", "commit-tree", tree, "-p", head, "-m", msg]);
    return { head, wip };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export type SyncIn = {
  /** The worktree, here and in the box. */
  cwd: string;
  session: string;
  /** The box's environment for git: HOME, PATH, and GH_TOKEN where the order has one. */
  env: Record<string, string | undefined>;
  /** Tests: where the box's paths sit (a stand-in box on this machine); "" in a real box. */
  root?: string;
};

/** The worktree in the box, as it is here. Answers the commit it started from, which `syncOut` builds on (`PLAIN` for a
 * folder that is no checkout). */
export async function syncIn(box: BoxFs, o: SyncIn): Promise<string> {
  const { cwd, session } = o;
  if (!isCheckout(cwd)) return plainIn(box, cwd, session, o.root ?? "");
  const bx = (p: string) => (o.root ?? "") + p;
  const common = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const gitDir = await git(cwd, ["rev-parse", "--absolute-git-dir"]);
  const linked = gitDir !== common;
  const root = basename(common) === ".git" ? dirname(common) : undefined;
  if (linked && !root) throw new Error(`${cwd}'s repo has no worktree of its own at ${common}: hosted boxes take a plain checkout`);
  const origin = await tryGit(cwd, ["remote", "get-url", "origin"]);
  const branch = await tryGit(cwd, ["symbolic-ref", "-q", "--short", "HEAD"]);
  const { head, wip } = await snapshot(cwd, "fleetd: the work as the box started");
  const r = refs(session);
  const tmp = mkdtempSync(join(tmpdir(), "fleetd-bundle-"));
  try {
    await git(cwd, ["update-ref", `${r}/head`, head]);
    await git(cwd, ["update-ref", `${r}/wip`, wip]);
    const bundle = join(tmp, "in.bundle");
    // What origin holds the box clones from it: only what it lacks travels. Without an origin, everything does.
    const not = origin ? ["--not", "--remotes=origin"] : [];
    try {
      await git(cwd, ["bundle", "create", bundle, `${r}/head`, `${r}/wip`, ...not]);
    } catch {
      await git(cwd, ["bundle", "create", bundle, `${r}/head`, `${r}/wip`]);
    }
    const at = bx(`${BOX_DIR}/in-${session}.bundle`);
    await box.write(at, readFileSync(bundle));
    const who = { name: await tryGit(cwd, ["config", "user.name"]), email: await tryGit(cwd, ["config", "user.email"]) };
    const worktreeConfig = (await tryGit(cwd, ["config", "--type=bool", "extensions.worktreeConfig"])) === "true";
    const repo = root ?? cwd;
    const script = [
      "set -e",
      // The agent's pushes and gh calls, and the clone itself, take the order's token from the environment at each
      // call: the config holds no value.
      `git config --global credential.https://github.com.helper '!f() { test "$1" = get && echo username=x-access-token && echo "password=$GH_TOKEN"; }; f'`,
      `git config --global --add safe.directory '*'`,
      who.name ? `git config --global user.name ${q(who.name)}` : ":",
      who.email ? `git config --global user.email ${q(who.email)}` : ":",
      `if [ ! -e ${q(bx(join(repo, ".git")))} ]; then`,
      origin ? `  git clone -q --filter=blob:none --no-checkout ${q(origin)} ${q(bx(repo))}` : `  git init -q ${q(bx(repo))}`,
      // A clone already there is its bot's computer image's, as old as the image: it catches up with origin first, so the
      // bundle's commits (made against this machine's origin refs) have what they build on.
      origin ? `else git -C ${q(bx(repo))} fetch -q origin 2>/dev/null || true` : ":",
      "fi",
      `cd ${q(bx(repo))}`,
      worktreeConfig ? "git config extensions.worktreeConfig true" : ":",
      `git fetch -q ${q(at)} ${q(`${r}/*:${r}/*`)}`,
      `rm -f ${q(at)}`,
      // A ref whose commit origin has goes without it in the bundle (a reviewer's worktree at the PR's head, a fresh
      // branch at main's): each is set from its commit, which the clone or the bundle brought.
      `git update-ref ${q(`${r}/head`)} ${head}`,
      `git update-ref ${q(`${r}/wip`)} ${wip}`,
      linked
        ? `[ -e ${q(bx(join(cwd, ".git")))} ] || git worktree add -q -f ${branch ? `-B ${q(branch)}` : "--detach"} ${q(bx(cwd))} ${q(`${r}/head`)}`
        : branch ? `git checkout -q -B ${q(branch)} ${q(`${r}/head`)}` : `git checkout -q --detach ${q(`${r}/head`)}`,
      `cd ${q(bx(cwd))}`,
      `git reset -q --hard ${q(`${r}/head`)}`,
      `git read-tree -u --reset ${q(`${r}/wip`)}`,
      "git reset -q",
      branch && origin ? `git branch -q -u ${q(`origin/${branch}`)} 2>/dev/null || true` : ":",
      `echo "gitdir=$(git rev-parse --absolute-git-dir)"`,
    ].join("\n");
    const out = await sh(box, "cloning the repo", script, o.env);
    const boxGitDir = /gitdir=(.*)/.exec(out)?.[1]?.trim();
    // The worktree's own fleetd files (its hooks, the gate, the trees its check passed on) at the same git dir.
    if (linked && boxGitDir !== bx(gitDir))
      throw new Error(`the box's worktree has its git dir at ${boxGitDir ?? "(none)"}, not ${gitDir} as here, so fleetd's hooks wouldn't hold`);
    const own = readdirSync(gitDir).filter((n) => n.startsWith("fleetd-") || n === "config.worktree").map((n) => join(gitDir, n));
    await mirror(box, own, o.root);
    return head;
  } finally {
    await tryGit(cwd, ["update-ref", "-d", `${r}/head`]);
    await tryGit(cwd, ["update-ref", "-d", `${r}/wip`]);
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** The box's work back in the machine's worktree: its commits, and its uncommitted work as uncommitted changes (a
 * plain folder's, over the machine's). */
export async function syncOut(box: BoxFs, o: { cwd: string; session: string; base: string; env: Record<string, string | undefined>; root?: string }): Promise<void> {
  const { cwd, session, base } = o;
  if (base === PLAIN) return plainOut(box, cwd, session, o.env, o.root ?? "");
  const r = refs(session);
  const at = `${o.root ?? ""}${BOX_DIR}/out-${session}.bundle`;
  const script = [
    "set -e",
    // What the agent's commands source (the order's variables): git fetches what the clone left on origin (blobs a
    // bundle of a rebase needs) with the order's GitHub token as it is now.
    `[ -z "\${CLAUDE_ENV_FILE:-}" ] || [ ! -r "$CLAUDE_ENV_FILE" ] || . "$CLAUDE_ENV_FILE"`,
    `cd ${q((o.root ?? "") + cwd)}`,
    `t=$(mktemp); g=$(git rev-parse --absolute-git-dir); [ ! -e "$g/index" ] || cp "$g/index" "$t"`,
    `GIT_INDEX_FILE=$t git add -A`,
    `tree=$(GIT_INDEX_FILE=$t git write-tree); rm -f "$t"`,
    "head=$(git rev-parse HEAD)",
    `wip=$(git -c user.name=fleetd -c user.email=fleetd@localhost commit-tree "$tree" -p "$head" -m 'fleetd: the work as the box ended')`,
    `git update-ref ${q(`${r}/out-head`)} "$head"`,
    `git update-ref ${q(`${r}/out-wip`)} "$wip"`,
    `git bundle create -q ${q(at)} ${q(`${r}/out-head`)} ${q(`${r}/out-wip`)} --not ${q(base)} 2>/dev/null || git bundle create -q ${q(at)} ${q(`${r}/out-head`)} ${q(`${r}/out-wip`)}`,
  ].join("\n");
  await sh(box, "packing the box's work", script, o.env);
  const bytes = await box.read(at, BUNDLE_MAX);
  const tmp = mkdtempSync(join(tmpdir(), "fleetd-bundle-"));
  const wipRef = `${r}/out-wip`;
  try {
    const bundle = join(tmp, "out.bundle");
    writeFileSync(bundle, bytes);
    // The work is one commit on the box's HEAD. The bundle leaves that HEAD out when this machine has it already (the
    // box committed nothing since it started, or went back to an older commit), so it is read as the work's parent.
    await git(cwd, ["fetch", "-q", bundle, `+${wipRef}:${wipRef}`]);
    const wip = await git(cwd, ["rev-parse", "--verify", "-q", `${wipRef}^{commit}`]);
    const head = await git(cwd, ["rev-parse", "--verify", "-q", `${wip}^1`]);
    try {
      await git(cwd, ["reset", "-q", "--hard", head]);
      await git(cwd, ["clean", "-fdq"]);
      await git(cwd, ["read-tree", "-u", "--reset", wip]);
      await git(cwd, ["reset", "-q"]);
    } catch (error) {
      // Never lost: the work stays here under its ref, which the next bring-back replaces with the box's newer work.
      throw new Error(`the box's work came back but ${cwd} wasn't set to it (${(error as Error).message}); it is kept as ${wipRef}`);
    }
    await tryGit(cwd, ["update-ref", "-d", wipRef]);
  } finally {
    await tryGit(cwd, ["update-ref", "-d", `${r}/out-head`]);
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Copies `path` from the box to the same path here, when the box has it. */
export async function fetchBack(box: BoxFs, path: string, max: number): Promise<boolean> {
  let bytes: Uint8Array;
  try {
    bytes = await box.read(path, max);
  } catch {
    return false;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes, { mode: 0o600 });
  return true;
}

/** How much of a file's end `fetchNew` reads again, to check the box's copy still starts as this one does. */
const OVERLAP = 4096;

/** `fetchBack` for a file the box only appends to (a transcript): what it added since the copy here, when the box's copy
 * still matches this one where they meet; else the whole file. */
export async function fetchNew(box: BoxFs, path: string, max: number): Promise<boolean> {
  let have: Buffer | undefined;
  try {
    have = readFileSync(path);
  } catch {}
  if (!have || have.length <= OVERLAP) return fetchBack(box, path, max);
  const from = have.length - OVERLAP;
  let more: Uint8Array;
  try {
    more = await box.read(path, max, from);
  } catch {
    return false;
  }
  if (more.length < OVERLAP || Buffer.compare(Buffer.from(more.subarray(0, OVERLAP)), have.subarray(from)) !== 0) return fetchBack(box, path, max);
  if (more.length > OVERLAP) appendFileSync(path, more.subarray(OVERLAP));
  return true;
}

/** A chat file or image the agent made in the box, read under the same rules as on the machine (actions/image.ts):
 * inside its working directory or its scratch dir `scratch` (the same path in the box), a plain file, within the size. */
export async function readChatFile(box: BoxFs, root: string, path: string, offset: number, file: boolean, scratch?: string): Promise<Image> {
  const env = { PATH: "/usr/local/bin:/usr/bin:/bin" };
  const out = await box.run({ argv: ["realpath", "-e", "--", root, isAbsolute(path) ? path : join(root, path)], cwd: "/", env, timeoutSec: 30 });
  const [realRoot, real] = out.outputTail.trim().split("\n");
  if (out.exitCode !== 0 || !realRoot || !real) throw new Error(`${path} is not readable here: there is no such file in the agent's box`);
  const inside = (dir: string) => real === dir || real.startsWith(dir + sep);
  // The scratch dir as the box resolves it; one not made there holds nothing.
  const own = scratch === undefined || inside(realRoot) ? undefined : await box.run({ argv: ["realpath", "-e", "--", scratch], cwd: "/", env, timeoutSec: 30 });
  const realScratch = own?.exitCode === 0 ? own.outputTail.trim() : undefined;
  if (!inside(realRoot) && !(realScratch && inside(realScratch))) throw new Error(refused.outside(path, realRoot, file));
  const bytes = await box.read(real, ATTACHMENT_MAX_BYTES).catch((e: Error) => {
    throw new Error(`${path} is not readable here: ${e.message}`);
  });
  const tmp = mkdtempSync(join(tmpdir(), "fleetd-chat-file-"));
  try {
    writeFileSync(join(tmp, basename(real)), bytes);
    return readImage(tmp, basename(real), offset, file);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** A file's mtime, or 0. */
export const mtimeOf = (path: string) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};
