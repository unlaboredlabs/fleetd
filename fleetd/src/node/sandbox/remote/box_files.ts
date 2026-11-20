// What runs in a hosted box for its files, over the guest's link (`BoxFs`, ../box.ts): a shell script, the session's
// dirs made the box user's, a tar unpacked at the same paths. Box side (docs/CONTRIBUTING.md "The package"): what reads
// this machine's files and runs host git or tar is ./files.ts.
import { isAbsolute } from "node:path";
import type { ConfinedRun, RunOutcome } from "../../cmd/run.ts";
import { BOX_DIR } from "./bootstrap.ts";

export type { ConfinedRun, RunOutcome } from "../../cmd/run.ts";

/** What the node does with a box's files: Box (../box.ts) over the guest's link. */
export interface BoxFs {
  run(r: ConfinedRun): Promise<RunOutcome>;
  write(path: string, bytes: Uint8Array, mode?: number): Promise<void>;
  /** From byte `from` on, where the box kind can (a stand-in may give the whole file). */
  read(path: string, max: number, from?: number): Promise<Uint8Array>;
}

const GIT_SEC = 600;

export const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** Runs a shell script in the box; throws its output's tail when it fails. */
export async function sh(box: BoxFs, what: string, script: string, env: Record<string, string | undefined> = {}, timeoutSec = GIT_SEC): Promise<string> {
  const all: Record<string, string> = { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) all[k] = v;
  const r = await box.run({ argv: ["sh", "-c", script], cwd: "/", env: all, timeoutSec });
  if (r.notRun !== undefined) throw new Error(`${what}: ${r.notRun}`);
  if (r.exitCode !== 0) throw new Error(`${what} failed in the box${r.timedOut ? ` (it ran past ${timeoutSec} s)` : ""}: ${r.outputTail.trim().slice(-600)}`);
  return r.outputTail;
}

/** Makes each of `dirs` (outermost first) and leaves it the box user's. */
export async function prepare(box: BoxFs, dirs: string[]): Promise<void> {
  const roots = [...new Set(dirs.filter((d) => isAbsolute(d) && d !== "/"))].sort((a, b) => a.length - b.length);
  const steps = roots.map(
    (d) => `d=${q(d)}; [ -d "$d" ] || mkdir -p "$d" 2>/dev/null || sudo -n mkdir -p "$d"; [ -w "$d" ] || sudo -n chown "$(id -u):$(id -g)" "$d"`,
  );
  await sh(box, "making the agent's dirs", ["set -e", `mkdir -p ${q(BOX_DIR)}`, ...steps].join("\n"));
}

/** Unpacks `tar` in the box at the paths it holds (under `root`, for tests: a stand-in box on the same machine). */
export async function unpack(box: BoxFs, tar: Uint8Array, root = ""): Promise<void> {
  const at = `${root}${BOX_DIR}/files-${crypto.randomUUID()}.tar`;
  await box.write(at, tar);
  await sh(box, "unpacking the agent's files", `tar -C ${q(root || "/")} -xf ${q(at)} --no-same-owner; s=$?; rm -f ${q(at)}; exit $s`);
}
