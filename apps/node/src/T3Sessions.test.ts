import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect, Redacted } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import * as T3Sessions from "./T3Sessions.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-t3cmd-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

// Stands in for `t3`: records its argv and env, prints like `auth session issue --json` (log noise first).
const script = path.join(dir, "fake-t3.mjs");
fs.writeFileSync(
  script,
  `import fs from "node:fs";
const args = process.argv.slice(2);
const home = args[args.indexOf("--base-dir") + 1];
fs.appendFileSync(home + "/calls", JSON.stringify({ args, env: Object.keys(process.env) }) + "\\n");
if (fs.existsSync(home + "/fail")) {
  console.log(JSON.stringify({ token: "leaked-bearer-from-stdout" }));
  console.error("database is locked");
  process.exit(3);
}
if (args[2] === "issue") {
  console.log("timestamp=... level=INFO message=opening");
  console.log(JSON.stringify({ sessionId: "sess-1", token: "fresh-bearer", method: "bearer", expiresAt: "2026-10-17T11:00:00.000Z" }, null, 2));
} else {
  console.log("Revoked session " + args.at(-1) + ".");
}
`,
);

const t3Home = (name: string) => {
  const home = path.join(dir, name);
  fs.mkdirSync(home);
  return home;
};
const calls = (home: string) =>
  fs.readFileSync(path.join(home, "calls"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; env: string[] });

const sessions = (home: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* T3Sessions.T3Sessions;
    }).pipe(Effect.provide(T3Sessions.layerCli({ t3Cmd: [process.execPath, script], t3Home: home }))),
  );

describe("T3Sessions.layerCli", () => {
  it("mints a 1 h session for the given T3 home and revokes it by id, with a scrubbed environment", async () => {
    const home = t3Home("ok");
    const t3 = await sessions(home);
    process.env.CLAUDE_CODE_TEST_LEAK = "1";
    try {
      const session = await Effect.runPromise(t3.mint);
      expect({ ...session, bearer: Redacted.value(session.bearer) }).toEqual({
        sessionId: "sess-1",
        bearer: "fresh-bearer",
        expiresAt: "2026-10-17T11:00:00.000Z",
      });
      expect(String(session.bearer)).not.toContain("fresh-bearer");
      await Effect.runPromise(t3.revoke("sess-1"));
    } finally {
      delete process.env.CLAUDE_CODE_TEST_LEAK;
    }
    const [issue, revoke] = calls(home);
    expect(issue?.args).toEqual(["auth", "session", "issue", "--base-dir", home, "--ttl", "1h", "--label", "fleetd-node", "--json"]);
    expect(revoke?.args).toEqual(["auth", "session", "revoke", "--base-dir", home, "sess-1"]);
    expect(issue?.env.filter((key) => key.startsWith("CLAUDE"))).toEqual([]);
  });

  it("fails with T3's exit code and stderr, never its stdout", async () => {
    const home = t3Home("fail");
    fs.writeFileSync(path.join(home, "fail"), "");
    const t3 = await sessions(home);
    const error = await Effect.runPromise(Effect.flip(t3.mint));
    expect(error).toMatchObject({ _tag: "T3SessionError", operation: "issue", exitCode: 3, stderrTail: "database is locked" });
    expect(JSON.stringify(error) + error.message).not.toContain("leaked-bearer");
  });
});
