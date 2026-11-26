// `fleetd init`'s Claude login. Handed the person's terminal, claude's own "Paste code here" prompt never ended: each
// empty Enter printed "Invalid code" again, and Ctrl-D, Esc and Ctrl-C did nothing. The wizard now runs it on a
// terminal of its own and asks for the code itself: an empty Enter hints once, a second one or Ctrl-D skips, a wrong
// code can be pasted again, and a sign-in in the browser it opened ends it alone.
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const loginTs = join(import.meta.dir, "../../src/cli/setup/claude_login.ts");
const wizardTs = join(import.meta.dir, "../../src/cli/setup/wizard.ts");
const checklistTs = join(import.meta.dir, "../../src/cli/setup/checklist.ts");

/** A stand-in claude whose `auth login` acts as 2.1's: a wrong or empty code says so and waits again, Ctrl-C and
 * Ctrl-D are ignored. With a browser to open (BROWSER not `true`) its page's sign-in ends it a moment later. */
function fakeClaude(dir: string): string {
  const script = join(dir, "fake-login.ts");
  writeFileSync(
    script,
    `process.stdout.write("Opening browser to sign in…\\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&x=1\\nPaste code here if prompted > ");
    if (process.env.BROWSER !== "true") setTimeout(() => { process.stdout.write("\\nLogin successful.\\n"); process.exit(0); }, 50);
    let got = ""; process.stdin.setRawMode?.(true);
    process.stdin.on("data", (d) => { got += d.toString().replace(/[\\x03\\x04\\x1b]/g, "");
      while (got.includes("\\r")) { const [code] = got.split("\\r"); got = got.slice(code.length + 1);
        if (code.trim() === "good-code") { process.stdout.write("\\nLogin successful.\\n"); process.exit(0); }
        process.stdout.write("Invalid code. Please make sure the full code was copied.\\n"); } });`,
  );
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\n[ "$1 $2" = "auth login" ] || exit 2\nexec '${process.execPath}' '${script}'\n`);
  chmodSync(bin, 0o755);
  return bin;
}

/** claudeLogin in a fresh bun with `typed` on its stdin; what it printed, what it answered and how long it took. */
async function run(typed: string, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-claude-login-"));
  const bin = fakeClaude(dir);
  writeFileSync(
    join(dir, "child.ts"),
    `const { claudeLogin } = await import(${JSON.stringify(loginTs)});
const { Ui } = await import(${JSON.stringify(wizardTs)});
const { Checklist } = await import(${JSON.stringify(checklistTs)});
console.log("RESULT " + JSON.stringify(await claudeLogin(new Ui(true), new Checklist(), [${JSON.stringify(bin)}, "auth", "login"], true)));
`,
  );
  const started = Date.now();
  const base = { ...process.env, NO_COLOR: "1" } as Record<string, string>;
  delete base.DISPLAY;
  delete base.WAYLAND_DISPLAY;
  delete base.BROWSER;
  const proc = Bun.spawn(["bun", join(dir, "child.ts")], { cwd: dir, stdin: new Blob([typed]), stdout: "pipe", stderr: "pipe", env: { ...base, ...env } });
  const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { said: stderr, result: JSON.parse(/RESULT (.*)/.exec(stdout)?.[1] ?? "null"), exit, ms: Date.now() - started };
}

/** Linux, whose screen is only DISPLAY's: macOS always has one, so a browser always opens there. */
const linux = process.platform === "linux";
const count = (text: string, part: string) => text.split(part).length - 1;

test.skipIf(!linux)("an empty Enter hints once and a second (or Esc) skips, never claude's Invalid code loop", async () => {
  const ran = await run("\n\x1b\n");
  expect(ran.said).toContain("https://claude.com/cai/oauth/authorize?code=true&x=1");
  expect(count(ran.said, "No code yet: paste the code the page shows once you've signed in, or press Enter again to skip")).toBe(1);
  expect(ran.said).not.toContain("Invalid code");
  expect(ran.result).toBe(false);
  expect(ran.exit).toBe(0);
}, 20_000);

test.skipIf(!linux)("Ctrl-D at the code ends the step at once", async () => {
  const ran = await run("");
  expect(ran.said).not.toContain("No code yet");
  expect(ran.result).toBe(false);
  expect(ran.exit).toBe(0);
  expect(ran.ms).toBeLessThan(10_000);
}, 20_000);

test.skipIf(!linux)("a wrong code says claude's words and takes the code again in the same login", async () => {
  const ran = await run("bad\ngood-code\n");
  expect(count(ran.said, "Invalid code. Please make sure the full code was copied. Paste it again, or press Enter to skip.")).toBe(1);
  expect(ran.said).not.toContain("good-code");
  expect(ran.said).not.toContain("Paste code here");
  expect(ran.result).toBe(true);
}, 20_000);

test.skipIf(!linux)("with a screen, the browser it opened signs it in and Enter finds it done", async () => {
  const ran = await run("\n", { DISPLAY: ":0" });
  expect(ran.said).toContain("Sign in to Claude in the browser that opened");
  expect(ran.said).not.toContain("No code yet");
  expect(ran.result).toBe(true);
}, 20_000);
