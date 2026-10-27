import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { afterEach, describe, expect, it } from "vitest";
import type { HubFrame } from "../../shared/hub";
import { saveCredentials, type CredentialEnv } from "./credentials";
import type { FixtureFile } from "./fixture";
import { HUB_LIST, HUB_LIST_BAD, Hubs, RECOVERED_NOTE } from "./hubs";
import type { Transport } from "./transport";

const dirs: string[] = [];
const dir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "fleetd-hubs-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const noSocket: Transport = () => ({ send: () => undefined, ping: () => undefined, close: () => undefined });

const setup = () => {
  const home = dir();
  const credentials: CredentialEnv = { dir: home, platform: "linux", crypto: null, keychain: null, teamSigned: () => false, bundleId: () => null };
  const make = () => new Hubs({ kind: "hub", dir: home, credentials, vars: {}, transport: noSocket, cacheDir: dir() });
  return { home, credentials, make };
};

describe("hubs", () => {
  it("starts an upgraded app as its first hub, labelled by host until named, and writes nothing until a change", () => {
    const { home, credentials, make } = setup();
    saveCredentials(credentials, { url: "http://devbox.tail1234.ts.net:4790", key: "k1" });
    const hubs = make();
    expect(hubs.list()).toEqual([{ id: "hub", label: "devbox" }]);
    expect(existsSync(join(home, HUB_LIST))).toBe(false);
    hubs.stop();
  });

  it("adds a second hub under a free-form label, with its key in a file of its own, and keeps both across launches", () => {
    const { home, credentials, make } = setup();
    saveCredentials(credentials, { url: "http://devbox:4790", key: "k1" });
    const hubs = make();
    expect(hubs.connect({ url: "http://acme-hub:4790", key: "k2" }, { label: "  Acme   corp ", color: "violet" })).toEqual({ ok: true });
    const [first, second] = hubs.list();
    expect(first).toEqual({ id: "hub", label: "devbox" });
    expect(second).toMatchObject({ label: "Acme corp", color: "violet" });
    const id = second?.id ?? "";
    expect(readFileSync(join(home, `desktop-hub-${id}.json`), "utf8")).toContain("k2");
    // The first hub's key is where it always was, and the list holds no key.
    expect(readFileSync(join(home, "desktop-hub.json"), "utf8")).toContain("k1");
    expect(readFileSync(join(home, HUB_LIST), "utf8")).not.toContain("k2");
    hubs.stop();

    const again = make();
    expect(again.list()).toEqual(hubs.list());
    expect(again.get(id)?.state()).toMatchObject({ hub: "http://acme-hub:4790" });
    again.stop();
  });

  it("renames, recolours and refuses an empty label", () => {
    const { credentials, make } = setup();
    saveCredentials(credentials, { url: "http://devbox:4790", key: "k1" });
    const hubs = make();
    expect(hubs.update("hub", { label: "Personal", color: "green" })).toEqual({ ok: true });
    expect(hubs.list()).toEqual([{ id: "hub", label: "Personal", color: "green" }]);
    expect(hubs.update("hub", { label: "Personal", color: null })).toEqual({ ok: true });
    expect(hubs.list()).toEqual([{ id: "hub", label: "Personal" }]);
    expect(hubs.update("hub", { label: "   ", color: null }).ok).toBe(false);
    hubs.stop();
  });

  it("removes one hub and its key, leaving the other; the last one forgets its key and starts over under a new id", () => {
    const { home, credentials, make } = setup();
    saveCredentials(credentials, { url: "http://devbox:4790", key: "k1" });
    const hubs = make();
    hubs.connect({ url: "http://acme-hub:4790", key: "k2" }, { label: "Acme" });
    const acme = hubs.list()[1]?.id ?? "";
    const seen: string[][] = [];
    hubs.onChange((list) => seen.push(list.map((h) => h.label)));
    hubs.remove("hub");
    expect(hubs.list()).toEqual([{ id: acme, label: "Acme" }]);
    expect(existsSync(join(home, "desktop-hub.json"))).toBe(false);
    expect(seen).toEqual([["Acme"]]);
    hubs.remove(acme);
    const [left] = hubs.list();
    expect(left?.label).toBe("Hub");
    expect([acme, "hub"]).not.toContain(left?.id);
    expect(hubs.get(left?.id ?? "")?.state().phase).toBe("unpaired");
    expect(hubs.firstRun()).toBe(true);
    hubs.stop();
  });

  it("never hands out a removed hub's id again, the first's included", () => {
    const { credentials, make } = setup();
    saveCredentials(credentials, { url: "http://devbox:4790", key: "k1" });
    const hubs = make();
    hubs.connect({ url: "http://acme-hub:4790", key: "k2" }, { label: "Acme" });
    const acme = hubs.list()[1]?.id ?? "";
    hubs.remove("hub");
    hubs.connect({ url: "http://side-hub:4790", key: "k3" }, { label: "Side project" });
    hubs.remove(acme);
    hubs.connect({ url: "http://other-hub:4790", key: "k4" }, { label: "Other" });
    const ids = hubs.list().map((h) => h.id);
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain("hub");
    expect(ids).not.toContain(acme);
    hubs.stop();
  });

  it("pairs a hub already listed again rather than adding it twice, however its address is typed", () => {
    const { home, credentials, make } = setup();
    saveCredentials(credentials, { url: "http://devbox:4790", key: "k1" });
    const hubs = make();
    hubs.connect({ url: "http://acme-hub:4790", key: "k2" }, { label: "Acme" });
    expect(hubs.connect({ url: "acme-hub:4790/", key: "k3" }, { label: "Acme again" })).toEqual({ ok: true });
    expect(hubs.list().map((h) => h.label)).toEqual(["devbox", "Acme"]);
    const acme = hubs.list()[1]?.id ?? "";
    expect(readFileSync(join(home, `desktop-hub-${acme}.json`), "utf8")).toContain("k3");
    hubs.stop();
  });

  it("loses no hub to a list it can't read: keeps it aside, finds the hubs again from their keys, and says so", () => {
    const { home, credentials, make } = setup();
    saveCredentials(credentials, { url: "http://devbox:4790", key: "k1" });
    const first = make();
    first.connect({ url: "http://acme-hub:4790", key: "k2" }, { label: "Acme" });
    const acme = first.list()[1]?.id ?? "";
    first.stop();
    writeFileSync(join(home, HUB_LIST), "{ not json");
    const hubs = make();
    expect(hubs.list()).toEqual([
      { id: "hub", label: "devbox", note: RECOVERED_NOTE },
      { id: acme, label: "acme-hub", note: RECOVERED_NOTE },
    ]);
    expect(hubs.get(acme)?.state()).toMatchObject({ hub: "http://acme-hub:4790" });
    expect(readFileSync(join(home, HUB_LIST_BAD), "utf8")).toBe("{ not json");
    // The hubs found again are saved, so the next launch has them without the note.
    hubs.stop();
    const again = make();
    expect(again.list().map((h) => [h.id, h.note])).toEqual([
      ["hub", undefined],
      [acme, undefined],
    ]);
    again.stop();
  });

  it("pairs a fresh app's one hub under the label given rather than adding a second", () => {
    const { make } = setup();
    const hubs = make();
    expect(hubs.firstRun()).toBe(true);
    expect(hubs.connect({ url: "http://devbox:4790", key: "k1" }, { label: "Personal" })).toEqual({ ok: true });
    expect(hubs.list()).toEqual([{ id: "hub", label: "Personal" }]);
    hubs.stop();
  });

  it("tags each hub's frames with its id, so one window hears both", () => {
    const one = (name: string, phase: "live" | "retrying"): FixtureFile => ({
      version: 1,
      name,
      note: "",
      now: "2026-10-19T10:30:00.000Z",
      state: phase === "live" ? { phase, hub: `http://${name}:4790`, protocol: 1 } : { phase, hub: `http://${name}:4790`, reason: "refused", retryAt: 0 },
      frames: [],
      calls: [],
    });
    const hubs = new Hubs({ kind: "fixture", fixture: { ...one("devbox", "live"), label: "Personal", hubs: [{ label: "Acme", color: "amber", fixture: one("acme", "retrying") }] } });
    expect(hubs.list()).toEqual([
      { id: "hub", label: "Personal" },
      { id: "h2", label: "Acme", color: "amber" },
    ]);
    const sent: Array<[string, HubFrame]> = [];
    const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: (_channel: string, hub: string, frame: HubFrame) => sent.push([hub, frame]) });
    for (const service of hubs.all()) service.subscribe(contents as unknown as WebContents);
    // Each starts from its own state: one live, the other offline beside it.
    expect(sent.map(([hub, f]) => [hub, f.t === "state" ? f.state.phase : f.t])).toEqual([
      ["hub", "live"],
      ["h2", "retrying"],
    ]);
    hubs.stop();
  });
});
