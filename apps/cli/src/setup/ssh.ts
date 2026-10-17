import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { q } from "./units.ts";

export interface SshTarget {
  readonly host: string;
  /** An ssh_config file (`ssh -F`), e.g. a lab's own host, port and key. */
  readonly config?: string;
}

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const sshArgs = (target: SshTarget) => [...(target.config === undefined ? [] : ["-F", target.config]), "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", target.host];

/** How a command is shown before it runs: what you would type to run it yourself. */
export const showSsh = (target: SshTarget, command: string) =>
  `ssh ${[...(target.config === undefined ? [] : ["-F", target.config]), target.host].map(q).join(" ")} ${q(command)}`;

/** Runs `command` under the remote user's `sh`, whatever their login shell is. */
export const runSsh = (target: SshTarget, command: string, stdin?: Buffer | string) => runLocal("ssh", [...sshArgs(target), "--", `sh -c ${q(command)}`], stdin);

export const runLocal = (file: string, args: ReadonlyArray<string>, stdin?: Buffer | string) =>
  new Promise<RunResult>((resolve) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Array<Buffer> = [];
    const err: Array<Buffer> = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => resolve({ code: 127, stdout: "", stderr: error.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });

/** sha256 over a directory's sorted relative paths and contents; the probe computes the same on the machine. */
export const directoryDigest = (dir: string) => {
  const hash = crypto.createHash("sha256");
  for (const rel of fs.readdirSync(dir, { recursive: true }).map(String).sort()) {
    const file = path.join(dir, rel);
    if (fs.statSync(file).isFile()) hash.update(`${rel}\0`).update(fs.readFileSync(file)).update("\0");
  }
  return hash.digest("hex");
};
