// A stand-in `claude` executable for router tests: first on PATH, it records each call (args, environment, prompt
// on stdin) in the router's config dir and prints the next canned reply. No model is ever called.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Reply {
  readonly stdout: string;
  readonly exit?: number;
}

export interface Call {
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly prompt: string;
}

const SCRIPT = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = process.env.CLAUDE_CONFIG_DIR;
let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  const n = fs.readdirSync(dir).filter((f) => f.startsWith("call-")).length + 1;
  fs.writeFileSync(path.join(dir, "call-" + n + ".json"), JSON.stringify({ args: process.argv.slice(2), env: process.env, prompt }));
  const reply = JSON.parse(fs.readFileSync(path.join(dir, "replies.json"), "utf8"))[n - 1] ?? { stdout: "", exit: 1 };
  process.stdout.write(reply.stdout);
  process.exitCode = reply.exit ?? 0;
});
`;

/** What `claude -p --output-format json` prints for a successful run whose answer is `answer`. */
export const result = (answer: unknown, usage = { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 30 }): Reply => ({
  stdout: JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1200,
    result: typeof answer === "string" ? answer : JSON.stringify(answer),
    usage,
  }),
});

export const makeFakeClaude = (replies: ReadonlyArray<Reply>) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-router-"));
  const bin = path.join(root, "bin");
  const home = path.join(root, "hub");
  const configDir = path.join(home, "claude-router");
  fs.mkdirSync(bin);
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(bin, "claude"), SCRIPT, { mode: 0o755 });
  fs.writeFileSync(path.join(configDir, "replies.json"), JSON.stringify(replies));
  return {
    home,
    /** The hub's environment as the router sees it, with session variables it must drop. */
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      HOME: root,
      ANTHROPIC_BASE_URL: "http://proxy.invalid",
      ANTHROPIC_AUTH_TOKEN: "test-token",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CONFIG_DIR: "/somewhere/else",
    },
    calls: (): ReadonlyArray<Call> =>
      fs
        .readdirSync(configDir)
        .filter((f) => f.startsWith("call-"))
        .sort((a, b) => Number(a.slice(5, -5)) - Number(b.slice(5, -5)))
        .map((f) => JSON.parse(fs.readFileSync(path.join(configDir, f), "utf8")) as Call),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
};
