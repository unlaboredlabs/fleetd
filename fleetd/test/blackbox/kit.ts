// What the black-box tests share: the fleetd under test (FLEETD_BIN, the compiled dist/fleetd: `bun run blackbox`),
// run with an environment of the test's own. Each call gets its own FLEETD_HOME and none of the caller's FLEETD_*
// (an agent's FLEETD_NODE_SOCK, say), so nothing reaches a real hub or node.
import { chmodSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** The binary under test, or undefined when FLEETD_BIN isn't set: the tests that run it are skipped then. */
export const BIN = process.env.FLEETD_BIN ? resolve(process.env.FLEETD_BIN) : undefined;

/** The caller's environment without anything that points at a real fleet or Claude config, plus `env`. */
export function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("FLEETD_") || key === "CLAUDE_CONFIG_DIR") continue;
    out[key] = value;
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return out;
}

export type Ran = { code: number | null; signal: string | null; stdout: string; stderr: string };

/** Runs `argv` to its end with stdin closed and `env` as is (cleanEnv's); `stdout` a file descriptor to write it to. */
export async function run(argv: string[], env: Record<string, string>, stdout?: number): Promise<Ran> {
  const child = Bun.spawn(argv, { env, stdin: "ignore", stdout: stdout ?? "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    typeof child.stdout === "number" || !child.stdout ? "" : new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await child.exited;
  return { code: child.exitCode, signal: child.signalCode === null ? null : String(child.signalCode), stdout: out, stderr: err };
}

/** A port nothing listens on, for a hub's `--listen`. */
export function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

/** Writes an executable `#!/bin/sh` script. */
export function script(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}`);
  chmodSync(path, 0o755);
}
