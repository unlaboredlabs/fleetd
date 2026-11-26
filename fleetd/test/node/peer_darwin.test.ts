// The node's word on which session a caller runs in, on macOS: its ancestry from proc_pidinfo and its environment
// from sysctl KERN_PROCARGS2, which has no /proc (node/lead/peer.ts). The parser runs everywhere; the calls on a Mac.
import { expect, test } from "bun:test";
import { darwinEnvOf, darwinParentOf, parentOf, peerSession, procArgsEnv, SESSION_MARKER } from "../../src/node/lead/peer.ts";

/** KERN_PROCARGS2's layout: argc, the executable's path, its padding, argv, then the environment. */
function procArgs(exec: string, argv: string[], env: string[]): Uint8Array {
  const text = [exec, "", "", ...argv, ...env, ""].join("\0");
  const out = new Uint8Array(4 + text.length);
  new DataView(out.buffer).setInt32(0, argv.length, true);
  out.set(new TextEncoder().encode(text), 4);
  return out;
}

test("a macOS process's environment: past its executable, padding and arguments", () => {
  const raw = procArgs("/bin/sh", ["sh", "-c", "mac sim start"], [`${SESSION_MARKER}=s1.2`, "HOME=/Users/ada"]);
  expect(procArgsEnv(raw)).toEqual([`${SESSION_MARKER}=s1.2`, "HOME=/Users/ada"]);
  expect(procArgsEnv(procArgs("/bin/sh", [], []))).toEqual([]);
  expect(procArgsEnv(new Uint8Array(2))).toEqual([]);
});

test("a caller several processes down from a session's claude is that session's, by its ancestry", () => {
  const parents = new Map([[40, 30], [30, 20], [20, 10]]);
  expect(peerSession(40, new Map([[10, "s1"]]), (p) => parents.get(p))).toEqual({ kind: "session", session: "s1" });
});

test.skipIf(process.platform !== "darwin")("on macOS: this process's parent and environment, as the kernel gives them", () => {
  expect(darwinParentOf(process.pid)).toBe(process.ppid);
  expect(parentOf(process.pid)).toBe(process.ppid);
  expect(darwinEnvOf(process.pid)).toContain(`HOME=${process.env.HOME}`);
});
