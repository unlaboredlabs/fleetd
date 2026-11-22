// Stand-ins for what a real node reaches for as it starts: `npm`, which installs agent-browser in the background, and
// `claude`, whose login it checks. The real ones went to the network, outlived the test and wrote ~170 MB into its home
// after the test removed it (an npm cache, agent-browser, claude's own files). These answer at once and write nothing.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TESTED } from "../src/node/runner/claude.ts";

/** Writes the stand-ins in `dir`/tools and answers the environment a node (or the CLI that starts one) runs them from:
 * PATH with them first, and FLEETD_CLAUDE_BIN, which the node takes before PATH. */
export function standInTools(dir: string, path = process.env.PATH ?? "/usr/bin:/bin"): { PATH: string; FLEETD_CLAUDE_BIN: string } {
  const bin = join(dir, "tools");
  mkdirSync(bin, { recursive: true });
  const tool = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  tool("npm", `echo "npm: a test's stand-in, which installs nothing" >&2; exit 1`);
  tool("claude", `echo '${TESTED} (Claude Code)'`);
  return { PATH: `${bin}:${path}`, FLEETD_CLAUDE_BIN: join(bin, "claude") };
}
