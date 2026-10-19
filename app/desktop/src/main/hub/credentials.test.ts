import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearCredentials, fromEnv, keyStoreOf, loadCredentials, osEncryption, PAIR_AGAIN, saveCredentials, useOsEncryption, type CredentialEnv } from "./credentials";

let dir: string;
let keychainReads: Array<string>;

/** Reversible and visibly not plaintext, so tests can tell the encrypted store from the file. */
const crypto = {
  encrypt: (text: string) => Buffer.from(`enc:${text}`),
  decrypt: (blob: Buffer) => {
    const text = blob.toString("utf8");
    if (!text.startsWith("enc:")) throw new Error("not ours");
    return text.slice(4);
  },
};

const env = (over: Partial<CredentialEnv> & { items?: Record<string, string>; denied?: boolean } = {}): CredentialEnv => ({
  dir,
  platform: "linux",
  crypto,
  teamSigned: () => true,
  bundleId: () => "sh.fleetd.app",
  keychain: {
    get: (service, account) => {
      keychainReads.push(`${service}/${account}`);
      if (over.denied === true) throw new Error("denied");
      return over.items?.[`${service}/${account}`] ?? null;
    },
  },
  ...over,
});

const gpui = JSON.stringify({ url: "http://devbox:4790", key: "old-key" });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fleetd-cred-"));
  keychainReads = [];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("credentials", () => {
  it("saves encrypted, 0600 in a 0700 dir, and loads it back without touching the keychain", () => {
    saveCredentials(env(), { url: "http://devbox:4790", key: "k" });
    const file = join(dir, "desktop-hub.bin");
    expect(readFileSync(file, "utf8")).toMatch(/^enc:/u);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(loadCredentials(env())).toEqual({ saved: { url: "http://devbox:4790", key: "k" } });
    expect(keychainReads).toEqual([]);
  });

  it("falls back to a private plain file when the OS has no real encryption", () => {
    saveCredentials(env({ crypto: null }), { url: "http://devbox:4790", key: "k" });
    expect(JSON.parse(readFileSync(join(dir, "desktop-hub.json"), "utf8"))).toEqual({ url: "http://devbox:4790", key: "k" });
    expect(loadCredentials(env({ crypto: null })).saved?.key).toBe("k");
  });

  it("says so when the encrypted key can't be read any more", () => {
    writeFileSync(join(dir, "desktop-hub.bin"), "garbage");
    expect(loadCredentials(env())).toEqual({ saved: null, note: "The saved key couldn't be read. Pair again to continue." });
  });

  it("moves the GPUI app's Linux keychain entry over once, ever", () => {
    const items = { "fleetd/hub": gpui };
    expect(loadCredentials(env({ items }))).toEqual({ saved: { url: "http://devbox:4790", key: "old-key" } });
    expect(readFileSync(join(dir, "desktop-hub.bin"), "utf8")).toBe(`enc:${gpui}`);
    clearCredentials(env());
    expect(loadCredentials(env({ items }))).toEqual({ saved: null });
    expect(keychainReads).toEqual(["fleetd/hub"]);
  });

  it("on macOS never retries a denied read, and asks to pair again", () => {
    const denied = env({ platform: "darwin", denied: true });
    expect(loadCredentials(denied)).toEqual({ saved: null, note: PAIR_AGAIN });
    expect(loadCredentials(denied)).toEqual({ saved: null });
    expect(keychainReads).toHaveLength(1);
  });

  it("on Linux without a Secret Service finds nothing to move, and says nothing", () => {
    expect(loadCredentials(env({ denied: true }))).toEqual({ saved: null });
  });

  it("on macOS takes the GPUI app's hub.json first, and leaves it in place", () => {
    writeFileSync(join(dir, "hub.json"), gpui, { mode: 0o600 });
    const mac = env({ platform: "darwin", items: { "fleetd/hub-developer-id": "{}" } });
    expect(loadCredentials(mac).saved?.key).toBe("old-key");
    expect(existsSync(join(dir, "hub.json"))).toBe(true);
    expect(keychainReads).toEqual([]);
  });

  it("on macOS reads the Developer ID item only when this build is team-signed too", () => {
    const items = { "fleetd/hub-developer-id": gpui };
    expect(loadCredentials(env({ platform: "darwin", items, teamSigned: () => false }))).toEqual({ saved: null });
    expect(keychainReads).toEqual([]);
    rmSync(join(dir, "desktop-migrated"));
    // Another bundle id: GPUI's item wouldn't trust it, so reading would prompt.
    expect(loadCredentials(env({ platform: "darwin", items, bundleId: () => "com.github.Electron" }))).toEqual({ saved: null });
    expect(keychainReads).toEqual([]);
    rmSync(join(dir, "desktop-migrated"));
    expect(loadCredentials(env({ platform: "darwin", items })).saved?.key).toBe("old-key");
    expect(keychainReads).toEqual(["fleetd/hub-developer-id"]);
  });

  it("never reads the OS keychain when it's off limits (FLEETD_HOME)", () => {
    expect(loadCredentials(env({ keychain: null }))).toEqual({ saved: null });
  });

  it("a fresh pairing settles the migration", () => {
    saveCredentials(env(), { url: "http://devbox:4790", key: "new" });
    clearCredentials(env());
    expect(loadCredentials(env({ items: { "fleetd/hub": gpui } }))).toEqual({ saved: null });
    expect(keychainReads).toEqual([]);
  });

  it("uses FLEETD_HUB_URL + FLEETD_AGENT_KEY only when both are set", () => {
    expect(fromEnv({ FLEETD_HUB_URL: "http://h", FLEETD_AGENT_KEY: "k" })).toEqual({ url: "http://h", key: "k" });
    expect(fromEnv({ FLEETD_HUB_URL: "http://h" })).toBeNull();
    expect(fromEnv({ FLEETD_HUB_URL: "http://h", FLEETD_AGENT_KEY: "" })).toBeNull();
  });
});

describe("useOsEncryption", () => {
  const ask = (over: Partial<Parameters<typeof useOsEncryption>[0]>) => {
    const asked: Array<string> = [];
    const use = useOsEncryption({
      platform: "darwin",
      relocated: false,
      teamSigned: () => (asked.push("teamSigned"), true),
      available: () => (asked.push("available"), true),
      linuxBackend: () => (asked.push("backend"), "gnome_libsecret"),
      ...over,
    });
    return { use, asked };
  };

  it("on an unsigned or ad-hoc Mac never asks safeStorage anything", () => {
    expect(ask({ teamSigned: () => false })).toEqual({ use: false, asked: [] });
  });

  it("on a team-signed Mac checks the signature before safeStorage", () => {
    expect(ask({})).toEqual({ use: true, asked: ["teamSigned", "available"] });
  });

  it("never touches the OS store for a relocated home", () => {
    expect(ask({ relocated: true })).toEqual({ use: false, asked: [] });
  });

  it("on Linux refuses the plain-text backend", () => {
    expect(ask({ platform: "linux", linuxBackend: () => "basic_text" }).use).toBe(false);
    expect(ask({ platform: "linux" }).use).toBe(true);
  });
});

describe("keyStoreOf", () => {
  it("says the key is encrypted only when the OS store is used, and otherwise why not and how to get there", () => {
    const facts = { platform: "linux" as const, relocated: false, teamSigned: () => true, available: () => true, linuxBackend: () => "gnome_libsecret" };
    expect(keyStoreOf(osEncryption(facts), "linux", "/x")).toEqual({ kind: "os", where: "your keyring (Secret Service)" });
    const basic = keyStoreOf(osEncryption({ ...facts, linuxBackend: () => "basic_text" }), "linux", "/x");
    expect(basic).toMatchObject({ kind: "file", path: "/x/desktop-hub.json" });
    expect(basic.kind === "file" && basic.fix).toContain("GNOME Keyring");
    const unsigned = keyStoreOf(osEncryption({ ...facts, platform: "darwin", teamSigned: () => false }), "darwin", "/x");
    expect(unsigned.kind === "file" && unsigned.fix).toContain("fleetd.sh");
    const relocated = keyStoreOf(osEncryption({ ...facts, relocated: true }), "linux", "/x");
    expect(relocated.kind === "file" && relocated.why).toContain("FLEETD_HOME");
  });
});
