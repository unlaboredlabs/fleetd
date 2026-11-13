// fleetd init's prompts as `curl -fsSL https://fleetd.sh | sh` runs them: the script is on stdin, so the installer
// hands init `</dev/tty`. On macOS Bun's stream reader asks kqueue to watch that fd, which refuses /dev/tty
// ("EINVAL: invalid argument, kqueue"), and readline threw it as an uncaught error. Linux's epoll accepts /dev/tty, so
// the first test stands in for macOS: process.stdin is a stream that fails as Bun's does there, and the answers come
// on a pipe. Prompts read with blocking reads and never touch that stream.
import { expect, test } from "bun:test";
import { mkdtempSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Checklist } from "../../src/cli/setup/checklist.ts";
import { notes, splitFix } from "../../src/cli/setup/wizard.ts";

const ttyTs = join(import.meta.dir, "../../src/cli/tty.ts");
const wizardTs = join(import.meta.dir, "../../src/cli/setup/wizard.ts");
const checklistTs = join(import.meta.dir, "../../src/cli/setup/checklist.ts");
const scratch = () => mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-prompt-"));

/** Runs `code` in a fresh bun with `stdin`; what it printed and how it ended. */
async function child(code: string, stdin: Blob | number) {
  const dir = scratch();
  writeFileSync(join(dir, "child.ts"), code);
  const proc = Bun.spawn(["bun", join(dir, "child.ts")], { cwd: dir, stdin, stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
  const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exit };
}

/** process.stdin as Bun gives it on macOS for /dev/tty: a terminal whose stream fails at its first read. */
const kqueueStdin = `
import { Readable } from "node:stream";
const stdin = new Readable({
  read() {
    this.destroy(Object.assign(new Error("EINVAL: invalid argument, kqueue"), { code: "EINVAL", syscall: "kqueue" }));
  },
});
Object.assign(stdin, { isTTY: true, setRawMode: () => stdin });
Object.defineProperty(process, "stdin", { get: () => stdin });
`;

test("init's prompts read the answers from a piped stdin that Bun's stream reader can't watch (macOS kqueue)", async () => {
  const ran = await child(
    `${kqueueStdin}
const tty = await import(${JSON.stringify(ttyTs)});
console.log(JSON.stringify(await tty.confirm("claude on devbox isn't logged in. Log in now?", true)));
console.log(JSON.stringify(await tty.select("Which?", [{ value: "a", label: "a" }, { value: "b", label: "b" }])));
console.log(JSON.stringify(await tty.input("Name")));
`,
    new Blob(["n\n2\ndevbox\n"]),
  );
  expect(ran.stderr).not.toContain("kqueue");
  expect(ran.stdout).toBe('false\n"b"\n"devbox"\n');
  expect(ran.exit).toBe(0);
});

test("a terminal that can't be read takes each prompt's default, offers no login, and prints no stack", async () => {
  const dir = scratch();
  // Reading a write-only fd fails (EBADF), as a terminal that went away does.
  const unreadable = openSync(join(dir, "gone"), "w");
  const ran = await child(
    `${kqueueStdin}
const { Ui } = await import(${JSON.stringify(wizardTs)});
const { Checklist } = await import(${JSON.stringify(checklistTs)});
const ui = new Ui(true);
const list = new Checklist();
console.log(JSON.stringify(await ui.offerToRun(list, "claude on devbox isn't logged in. Log in now?")));
console.log(JSON.stringify([ui.interactive, await ui.confirm(list, "Keep going?", true), await ui.select(list, "Which?", [["a", "a", ""], ["b", "b", ""]], "b")]));
`,
    unreadable,
  );
  expect(ran.stdout).toBe("false\n[false,true,\"b\"]\n");
  expect(ran.stderr).not.toContain("    at ");
  expect(ran.exit).toBe(0);
});

// A real terminal handed over as `</dev/tty`, as the installer does: the prompt reads it, a passphrase isn't echoed,
// and a login run at it gets the terminal's own device (a Bun-built claude dies on /dev/tty on macOS too).
const hasScript = process.platform === "linux" && Bun.spawnSync(["script", "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
test.skipIf(!hasScript)("in a terminal given as </dev/tty, prompts read it and logins get its own device", async () => {
  const dir = scratch();
  writeFileSync(
    join(dir, "child.ts"),
    `import { readlinkSync } from "node:fs";
import { confirm, readHidden, terminal } from ${JSON.stringify(ttyTs)};
const fd = terminal();
const login = Bun.spawnSync(["readlink", "/proc/self/fd/0"], { stdio: [fd, "pipe", "inherit"] }).stdout.toString().trim();
const answer = await confirm("Log in now?", true);
const secret = await readHidden("Passphrase: ");
console.log("RESULT " + JSON.stringify({ stdin: readlinkSync("/proc/self/fd/0"), own: readlinkSync("/proc/self/fd/" + fd), login, answer, secret: secret === "devbox-pass" }));
`,
  );
  const typing = "sleep 1; printf 'n\\r'; sleep 1; printf 'devbox-pass\\r'; sleep 2";
  const proc = Bun.spawn(["sh", "-c", `(${typing}) | script -qec 'bun child.ts </dev/tty' /dev/null`], {
    cwd: dir,
    env: { ...process.env, SHELL: "/bin/sh", NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const result = JSON.parse(/RESULT (.*)/.exec(stdout)?.[1] ?? "null");
  expect(result).toMatchObject({ stdin: "/dev/tty", answer: false, secret: true });
  expect(result.own).toMatch(/^\/dev\/pts\/\d+$/);
  expect(result.login).toBe(result.own);
  expect(stdout).not.toContain("devbox-pass");
  expect(exit).toBe(0);
}, 20_000);

test("a note that is its own fix prints once, without a Fix line", () => {
  const said = "launchd runs the node while devbox is logged in at this Mac's screen; after a restart, log that user in again.";
  const [why, fix] = splitFix(said);
  expect(why).toBe(fix);
  const list = new Checklist();
  list.rich = true;
  const written: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((text: string) => written.push(text) > 0) as typeof process.stderr.write;
  try {
    notes(list, [`note: ${said}`, "note: linger is no for devbox, so the node stops when devbox logs out. Fix: sudo loginctl enable-linger devbox"]);
  } finally {
    process.stderr.write = write;
  }
  const out = written.join("").replace(/\x1b\[[0-9;]*m/g, "");
  expect(out.split("after a restart, log that user in again").length).toBe(2);
  expect(out).not.toContain("Fix: launchd");
  expect(out).toContain("Fix: sudo loginctl enable-linger devbox");
});
