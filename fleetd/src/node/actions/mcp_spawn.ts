// How the node (and `fleetd mcp-probe`) starts a stdio MCP server for its Test (./mcp_probe.ts `Spawn`): in a
// process group of its own, so killing it takes whatever the server started too.
import type { Spawn } from "./mcp_probe.ts";

export const spawnGroup: Spawn = (argv, { cwd, env }) => {
  const proc = Bun.spawn(argv, { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true });
  return {
    stdin: proc.stdin,
    stdout: proc.stdout,
    stderr: proc.stderr,
    exited: proc.exited,
    get signalCode() {
      return proc.signalCode;
    },
    kill() {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {}
    },
  };
};
