import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { privateHubOrigin, readAppPairFile } from "./appPairFile";

const dir = () => mkdtempSync(join(tmpdir(), "fleetd-app-pair-"));
const BODY = JSON.stringify({ hub: "http://127.0.0.1:4790", code: "ABCD-2345", expiresAt: "2099-01-01T00:00:00Z" });

const write = (mode: number, body = BODY): string => {
  const path = join(dir(), "app-pair.json");
  writeFileSync(path, body, { mode });
  chmodSync(path, mode);
  return path;
};

const reason = async (path: string) => {
  const read = await readAppPairFile(path);
  return read.ok || read.missing ? null : read.failure.message;
};

describe.skipIf(process.platform === "win32")("readAppPairFile", () => {
  it("reads a private regular file", async () => {
    expect(await readAppPairFile(write(0o600))).toEqual({ ok: true, text: BODY });
  });

  it("reports a missing file as missing, not as a problem", async () => {
    expect(await readAppPairFile(join(dir(), "app-pair.json"))).toEqual({ ok: false, missing: true });
  });

  it("refuses a file others can read", async () => {
    expect(await reason(write(0o644))).toContain("0600");
  });

  it("refuses a symlink, even to a good file or /dev/zero", async () => {
    const link = join(dir(), "app-pair.json");
    symlinkSync(write(0o600), link);
    expect(await reason(link)).toContain("symlink");
    const zero = join(dir(), "app-pair.json");
    symlinkSync("/dev/zero", zero);
    expect(await reason(zero)).toContain("symlink");
  });

  it("refuses a FIFO without waiting for a writer", async () => {
    const fifo = join(dir(), "app-pair.json");
    execFileSync("mkfifo", ["-m", "600", fifo]);
    expect(await reason(fifo)).toContain("regular file");
  });

  it("refuses a file too large to be a pairing file", async () => {
    expect(await reason(write(0o600, "x".repeat(5000)))).toContain("too large");
  });
});

describe("privateHubOrigin", () => {
  it("accepts this computer, private networks and tailnets", () => {
    for (const origin of [
      "http://127.0.0.1:4790",
      "http://localhost:4790",
      "http://[::1]:4790",
      "http://192.168.1.20:4790",
      "http://10.0.0.5:4790",
      "http://172.20.0.2:4790",
      "http://100.101.102.103:4790",
      "http://[fd7a:115c:a1e0::1]:4790",
      "https://devbox.tail1234.ts.net",
      "http://devbox:4790",
      "http://devbox.local:4790",
    ]) {
      expect(privateHubOrigin(origin), origin).toBe(true);
    }
  });

  it("refuses public hosts and other schemes", () => {
    for (const origin of ["https://hub.example.com", "http://8.8.8.8:4790", "http://172.32.0.1:4790", "http://100.128.0.1", "file:///etc/passwd", "http://[2001:db8::1]"]) {
      expect(privateHubOrigin(origin), origin).toBe(false);
    }
  });
});
