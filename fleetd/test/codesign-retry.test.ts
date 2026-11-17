// The macOS jobs' codesign (.github/release/codesign/codesign), with a stand-in for Apple's codesign: it signs again
// only when Apple's timestamp service didn't answer, a bounded number of times, and any other failure fails at once.
// macos-sign.sh signs the CLI through it. There's no Mac here: the edge workflow's macOS jobs run the real one.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RELEASE = join(import.meta.dir, "../../.github/release");
const UNAVAILABLE = "The timestamp service is not available.";
const EXPECTED = "A timestamp was expected but was not found.";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codesign-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A codesign whose signing calls answer `answers` in turn (`ok`, or the message it fails with), and whose display and
 * verify calls describe a Developer ID signature. Each signing call is a line in calls.log. */
function standIn(answers: string[]): string {
  writeFileSync(join(dir, "answers"), `${answers.join("\n")}\n`);
  const bin = join(dir, "bin");
  rmSync(bin, { recursive: true, force: true });
  mkdirSync(bin);
  const path = join(bin, "codesign");
  writeFileSync(
    path,
    `#!/usr/bin/env bash
case " $* " in
*" --sign "*)
  echo "$*" >> "${dir}/calls.log"
  n=$(wc -l < "${dir}/calls.log")
  answer=$(sed -n "\${n}p" "${dir}/answers")
  file="\${*: -1}"
  echo "$file: replacing existing signature" >&2
  [ "$answer" = ok ] && exit 0
  echo "$file: $answer" >&2
  exit 1 ;;
*" -dvv "*) printf 'Identifier=sh.fleetd.cli\\nflags=0x10000(runtime)\\nTeamIdentifier=ABCDE12345\\n' >&2 ;;
*" -r- "*) echo 'designated => anchor apple generic and certificate leaf[subject.OU] = ABCDE12345' ;;
esac
exit 0
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function run(argv: string[], env: Record<string, string> = {}) {
  const p = Bun.spawnSync(argv, {
    env: { PATH: `${join(dir, "bin")}:${process.env.PATH}`, RETRY_DELAY: "0", RUNNER_TEMP: dir, ...env },
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

const calls = () => readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n").length;
const shim = (real: string, env: Record<string, string> = {}) =>
  run([join(RELEASE, "codesign/codesign"), "--force", "--timestamp", "--sign", "ID", "app.bin"], { FLEETD_CODESIGN: real, ...env });

test("signs again after either of Apple's timestamp answers, logging each retry", () => {
  const r = shim(standIn([UNAVAILABLE, EXPECTED, "ok"]));
  expect(r.code).toBe(0);
  expect(calls()).toBe(3);
  const warnings = r.err.split("\n").filter((l) => l.startsWith("::warning::codesign failed"));
  expect(warnings).toHaveLength(2);
  expect(warnings[0]).toContain(`(try 1 of 5)`);
  expect(warnings[0]).toContain(UNAVAILABLE);
  expect(warnings[1]).toContain(EXPECTED);
  expect(readFileSync(join(dir, "codesign-retries.log"), "utf8").split("\n").filter(Boolean)).toEqual(warnings);
  // The last try's own output, as codesign gave it.
  expect(r.err.trim().endsWith("app.bin: replacing existing signature")).toBe(true);
});

test("gives up after CODESIGN_TRIES, with codesign's answer and status", () => {
  const r = shim(standIn([EXPECTED, EXPECTED, EXPECTED, "ok"]), { CODESIGN_TRIES: "3" });
  expect(r.code).toBe(1);
  expect(calls()).toBe(3);
  expect(r.err.trim().endsWith(`app.bin: ${EXPECTED}`)).toBe(true);
});

test("any other failure fails at once", () => {
  const r = shim(standIn(["The specified item could not be found in the keychain.", "ok"]));
  expect(r.code).toBe(1);
  expect(calls()).toBe(1);
  expect(r.err).not.toContain("::warning::");
  expect(existsSync(join(dir, "codesign-retries.log"))).toBe(false);
});

test("macos-sign.sh signs the CLI through it", () => {
  const real = standIn([UNAVAILABLE, "ok"]);
  const bin = join(dir, "fleetd-bun-darwin-arm64");
  writeFileSync(bin, "");
  const r = run([join(RELEASE, "macos-sign.sh"), "sign", bin], { FLEETD_CODESIGN: real, MACOS_SIGN_IDENTITY: "ID" });
  expect(r.code).toBe(0);
  expect(calls()).toBe(2);
  expect(r.err).toContain(`::warning::codesign failed (try 1 of 5)`);
  expect(r.out).toContain("TeamIdentifier=ABCDE12345");
});
