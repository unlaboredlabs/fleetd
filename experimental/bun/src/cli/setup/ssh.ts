// Running commands locally and on a machine over SSH, each with its stdin given up front
// (crates/fleetd/src/cli/setup/ssh.rs).
import { q } from "./units.ts";

export type SshTarget = {
  host: string;
  /** An ssh_config file (`ssh -F`). */
  config?: string;
  /** This machine, without SSH: `machine add --local`. */
  local: boolean;
};

export type RunResult = { code: number; stdout: string; stderr: string };

const configArgs = (t: SshTarget) => (t.config === undefined ? [] : ["-F", t.config]);

/** How a command is shown before it runs: what you would type to run it yourself. */
export function showSsh(t: SshTarget, command: string): string {
  if (t.local) return command;
  return `ssh ${[...configArgs(t), t.host].map(q).join(" ")} ${q(command)}`;
}

/** Runs `command` under the remote user's `sh`, whatever their login shell is. */
export function runSsh(t: SshTarget, command: string, stdin?: Uint8Array): Promise<RunResult> {
  if (t.local) return runLocal("/bin/sh", ["-c", command], stdin);
  return runLocal("ssh", [...configArgs(t), "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", t.host, "--", `sh -c ${q(command)}`], stdin);
}

/** Runs `command` with this terminal attached (a login flow), on the machine or here. */
export function runAttached(t: SshTarget, command: string): boolean {
  const argv = t.local ? ["/bin/sh", "-c", command] : ["ssh", ...configArgs(t), "-t", t.host, "--", `sh -c ${q(command)}`];
  try {
    return Bun.spawnSync(argv, { stdio: ["inherit", "inherit", "inherit"] }).exitCode === 0;
  } catch {
    return false;
  }
}

export async function runLocal(file: string, args: string[], stdin?: Uint8Array): Promise<RunResult> {
  let proc;
  try {
    proc = Bun.spawn([file, ...args], { stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    return { code: 127, stdout: "", stderr: (error as Error).message };
  }
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code: proc.signalCode ? 1 : code, stdout, stderr };
}
