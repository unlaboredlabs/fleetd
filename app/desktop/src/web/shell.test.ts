// The web app's half of the shell seam, with the browser faked: what each part does in place of the desktop's.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubFrame } from "../shared/hub";
import type { ConnectionEvents, Transport } from "../main/hub/link";
import { createWebShell, frameUrl, NEEDS_DESKTOP, platformOf, socketUrl, type WebDeps } from "./shell";
import type { WebSession } from "./session";

const ORIGIN = "https://app.fleetd.dev";
const SESSION: WebSession = {
  email: "lea@example.com",
  teams: [
    { id: "3f2b9c1e-0000-4000-8000-000000000001", name: "acme", url: "https://acme.fleetd.dev" },
    { id: "9a8b7c6d-0000-4000-8000-000000000002", name: "side", url: "https://side.fleetd.dev" },
  ],
  invitations: [],
};
const ACME = "3f2b9c1e00004000";

interface Call {
  readonly path: string;
  readonly init: RequestInit | undefined;
}

/** A fleetd cloud on the other end of fetch and the socket: records what the page asks, answers as told. */
const setup = (answer: (path: string, init?: RequestInit) => Response = () => new Response(null, { status: 404 }), session: WebSession = SESSION) => {
  const calls: Call[] = [];
  const sockets: Array<{ url: string; events: ConnectionEvents; sent: Array<Record<string, unknown>>; headers: Readonly<Record<string, string>> | undefined }> = [];
  const transport: Transport = (url, events, headers) => {
    const socket = { url, events, sent: [] as Array<Record<string, unknown>>, headers };
    sockets.push(socket);
    return { send: (text) => void socket.sent.push(JSON.parse(text) as Record<string, unknown>), ping: () => undefined, close: () => undefined };
  };
  const stored = new Map<string, string>();
  const went: string[] = [];
  const opened: string[] = [];
  const saved: Array<{ name: string; blob: Blob }> = [];
  let blocked = false;
  const deps: WebDeps = {
    fetch: (path, init) => {
      calls.push({ path, init });
      return Promise.resolve(answer(path, init));
    },
    transport,
    origin: ORIGIN,
    here: () => "/#/settings/general",
    go: (path) => void went.push(path),
    reload: () => void went.push("reload"),
    open: (url) => {
      opened.push(url);
      return blocked ? null : ({} as Window);
    },
    copy: () => Promise.resolve(),
    save: (name, blob) => void saved.push({ name, blob }),
    copyImage: () => Promise.resolve(),
    notify: () => Promise.resolve(true),
    setTitle: () => undefined,
    random: (n) => new Uint8Array(n).fill(0xab),
    storage: { getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => void stored.set(k, v) },
    platform: "darwin",
    version: "test",
  };
  const { api, hubs } = createWebShell(session, deps);
  return { api, hubs, calls, sockets, went, opened, saved, stored, block: () => (blocked = true) };
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const header = (init: RequestInit | undefined, name: string) => new Headers(init?.headers).get(name);

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 0, 1) });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the web shell", () => {
  it("says it is the web, with no fixture, vibrancy or cache", async () => {
    const { api } = setup();
    expect(api.shell).toBe("web");
    expect(api.fixture).toBeNull();
    expect(api.vibrancy).toBe(false);
    expect(await api.hub.cache.read(ACME)).toBeNull();
  });

  it("lists the account's teams as cloud hubs, and keeps a new name and colour in this browser", async () => {
    const { api, stored } = setup();
    expect(api.hubs.initial).toEqual([
      { id: ACME, label: "acme", cloud: true },
      { id: "9a8b7c6d00004000", label: "side", cloud: true },
    ]);
    const heard: unknown[] = [];
    api.hubs.subscribe((list) => heard.push(list));
    expect(await api.hubs.update(ACME, { label: "  Acme  Inc ", color: "green" })).toEqual({ ok: true });
    expect((await api.hubs.list())[0]).toEqual({ id: ACME, label: "Acme Inc", cloud: true, color: "green" });
    expect(heard).toHaveLength(1);
    expect(JSON.parse(stored.get("fleetd.web.teams") ?? "{}")).toEqual({ [SESSION.teams[0]?.id ?? ""]: { label: "Acme Inc", color: "green" } });
  });

  it("keeps two teams whose ids begin alike as two hubs, each with its own socket", () => {
    const twins: WebSession = {
      ...SESSION,
      teams: [
        { id: "acme-corporation-eu", name: "acme-eu", url: "https://acme-eu.fleetd.dev" },
        { id: "acme-corporation-us", name: "acme-us", url: "https://acme-us.fleetd.dev" },
      ],
    };
    const { api, sockets } = setup(undefined, twins);
    const listed = api.hubs.initial;
    expect(listed.map((h) => h.label)).toEqual(["acme-eu", "acme-us"]);
    expect(new Set(listed.map((h) => h.id)).size).toBe(2);
    for (const h of listed) api.hub.subscribe(h.id, () => undefined);
    expect(sockets.map((s) => s.url)).toEqual(["wss://app.fleetd.dev/t/acme-corporation-eu/app", "wss://app.fleetd.dev/t/acme-corporation-us/app"]);
  });

  it("opens each team's socket on this origin, with no key: the cookie is the auth", () => {
    const { api, sockets } = setup();
    const frames: HubFrame[] = [];
    api.hub.subscribe(ACME, (f) => frames.push(f));
    expect(sockets.map((s) => s.url)).toEqual([`wss://app.fleetd.dev/t/${SESSION.teams[0]?.id ?? ""}/app`]);
    const socket = sockets[0];
    if (socket === undefined) throw new Error("no socket");
    socket.events.onOpen();
    expect(socket.sent[0]).toMatchObject({ t: "auth", key: "" });
    socket.events.onText(JSON.stringify({ t: "ready", protocol: 1 }));
    socket.events.onText(JSON.stringify({ t: "snapshot", cursor: 3, machines: [] }));
    expect(frames.map((f) => (f.t === "state" ? `state:${f.state.phase}` : f.t))).toEqual(["state:connecting", "state:live", "snapshot"]);
    // Named by the team's own address, as the screens show it, though dialled on this origin.
    expect(frames[0]).toMatchObject({ t: "state", state: { hub: "https://acme.fleetd.dev" } });
    // A second subscriber starts from the state, then a fresh snapshot of its own; the socket is the same.
    api.hub.subscribe(ACME, () => undefined);
    expect(sockets).toHaveLength(1);
  });

  it("goes to Sign in, back to where it was, when a refused socket finds the session gone", async () => {
    const { api, sockets, went } = setup((path) => (path === "/web/session" ? new Response(null, { status: 401 }) : new Response(null, { status: 404 })));
    api.hub.subscribe(ACME, () => undefined);
    sockets[0]?.events.onClose(4401, "unauthorized");
    await vi.runAllTimersAsync();
    expect(went[0]).toBe("/web/sign-in?return=%2F%23%2Fsettings%2Fgeneral");
  });

  it("starts the page again when the session's teams changed since", async () => {
    const { api, sockets, went } = setup(() => json({ email: SESSION.email, teams: SESSION.teams.slice(1) }));
    api.hub.subscribe(ACME, () => undefined);
    sockets[0]?.events.onClose(4401, "unauthorized");
    await vi.runAllTimersAsync();
    expect(went).toEqual(["reload"]);
  });

  it("has the team's own address frame a report, with the fence and its key, never this origin", async () => {
    const team = SESSION.teams[0]?.id ?? "";
    const { api, calls } = setup((path) => (path === `/t/${team}/web/frames` ? json({ url: "https://acme.fleetd.dev/frames/abc" }) : new Response(null, { status: 404 })));
    const framed = await api.artifactFrame("<!doctype html><p>hi</p>", ACME);
    expect(framed).toEqual({ url: "https://acme.fleetd.dev/frames/abc", key: "ab".repeat(16) });
    const posted = calls[0];
    expect(posted?.init?.method).toBe("POST");
    expect(header(posted?.init, "x-fleetd-web")).toBe("1");
    const body = typeof posted?.init?.body === "string" ? posted.init.body : "";
    expect(body).toMatch(/^<!doctype html><script>/u);
    expect(body).toContain(`key: "${"ab".repeat(16)}"`);
  });

  it("refuses a report frame the cloud would serve on the web app's own origin", async () => {
    const { api } = setup(() => json({ url: `${ORIGIN}/frames/abc` }));
    await expect(api.artifactFrame("<p>x</p>", ACME)).rejects.toThrow(/no address/u);
    expect(frameUrl({ url: "http://acme.fleetd.dev/frames/a" }, ORIGIN)).toBeNull();
    expect(frameUrl({ url: "javascript:alert(1)" }, ORIGIN)).toBeNull();
    expect(frameUrl({ url: "http://acme.localhost:4800/frames/a" }, "http://127.0.0.1:4800")).toBe("http://acme.localhost:4800/frames/a");
  });

  it("never shows or copies a vault value, and asks the hub nothing for it", async () => {
    const { api, sockets } = setup();
    expect(await api.vault.reveal(ACME, { itemId: "V1", label: "Amazon", fields: ["password"] })).toMatchObject({ ok: false, error: { code: "desktop_only" } });
    expect(await api.vault.copy(ACME, { itemId: "V1", label: "Amazon", field: "password" })).toMatchObject({ ok: false });
    expect(sockets).toHaveLength(0);
  });

  it("answers the desktop-only parts as needing the desktop app", async () => {
    const { api } = setup();
    expect(await api.github.connect(ACME)).toMatchObject({ ok: false, error: { code: "desktop_only" } });
    expect(await api.hub.connect("http://devbox:4790", "k")).toEqual({ ok: false, message: NEEDS_DESKTOP });
    await expect(api.macSetup.status()).rejects.toThrow(NEEDS_DESKTOP);
    expect(await api.updates.state()).toEqual({ current: "test", app: { kind: "unsupported" }, release: null });
    expect(await api.projects.pickFolder()).toBeNull();
    expect(await api.machines.thisComputer()).toEqual({ kind: "none" });
    expect(await api.files.show("/tmp/x")).toEqual({ ok: false, message: NEEDS_DESKTOP });
  });

  it("calls a team's invites on this origin with the cookie and the web header, never a key", async () => {
    const team = SESSION.teams[0]?.id ?? "";
    const { api, calls } = setup(() => json({ invites: [] }));
    expect(await api.cloud.invites(ACME)).toEqual({ ok: true, invites: [] });
    expect(calls[0]?.path).toBe(`/t/${team}/accounts/v1/invites`);
    expect(header(calls[0]?.init, "authorization")).toBeNull();
    expect(header(calls[0]?.init, "x-fleetd-web")).toBe("1");
    expect(calls[0]?.init?.credentials).toBe("same-origin");
  });

  it("says a sign-out that didn't reach the cloud failed, and stays", async () => {
    const t = setup(() => json({ code: "failed", message: "Something broke." }, 503));
    expect(await t.api.cloud.signOut()).toEqual({ kept: [], failure: { code: "failed", message: "Not signed out: Something broke." } });
    expect(t.went).toEqual([]);
    const gone = setup(() => new Response(null, { status: 401 }));
    expect(await gone.api.cloud.signOut()).toEqual({ kept: [] });
    expect(gone.went).toEqual(["/"]);
  });

  it("signs out at the cloud, then goes to the start", async () => {
    const { api, calls, went } = setup(() => new Response(null, { status: 204 }));
    await api.cloud.signOut();
    expect(calls[0]).toMatchObject({ path: "/web/sign-out", init: { method: "POST" } });
    expect(went).toEqual(["/"]);
  });

  it("opens http(s) links in a new tab, and says when the browser blocked it", async () => {
    const t = setup();
    expect(await t.api.openExternal("javascript:alert(1)")).toMatchObject({ ok: false });
    expect(await t.api.openExternal("https://github.com/acme/app/pull/1")).toEqual({ ok: true });
    t.block();
    const blocked = await t.api.openExternal("https://fleetd.sh");
    expect(blocked.ok ? "" : blocked.message).toMatch(/blocked/u);
    expect(t.opened).toEqual(["https://github.com/acme/app/pull/1", "https://fleetd.sh/"]);
  });

  it("opens a session's pop-out as a tab of this page at its route", async () => {
    const t = setup();
    await t.api.app.sessionWindow({ machineId: "devbox", projectId: "p1", session: "s1", hub: ACME });
    expect(t.opened).toEqual([`/#/session/devbox/p1/s1?at=${ACME}`]);
  });

  it("saves a chat's file as a download, never opened in a tab of this origin", async () => {
    const t = setup();
    t.api.hub.subscribe(ACME, () => undefined);
    const socket = t.sockets[0];
    if (socket === undefined) throw new Error("no socket");
    socket.events.onOpen();
    socket.events.onText(JSON.stringify({ t: "ready", protocol: 1 }));
    socket.events.onText(JSON.stringify({ t: "snapshot", cursor: 1, machines: [] }));
    const opened = t.api.files.open(ACME, { projectRef: { machineId: "devbox", projectId: "p1" }, attachmentId: "F1" });
    await vi.advanceTimersByTimeAsync(0);
    const asked = socket.sent.find((f) => f["t"] === "call" && f["tool"] === "attachment_get");
    socket.events.onText(JSON.stringify({ t: "result", id: asked?.["id"], output: { name: "report.pdf", mime: "application/pdf", bytes: 7, dataB64: "PHA+PC9wPg==" } }));
    expect(await opened).toEqual({ ok: true });
    expect(t.saved.map((s) => [s.name, s.blob.type])).toEqual([["report.pdf", "application/octet-stream"]]);
  });
});

describe("socketUrl and platformOf", () => {
  it("makes a team's socket address of this origin's", () => {
    expect(socketUrl("https://app.fleetd.dev", "t 1")).toBe("wss://app.fleetd.dev/t/t%201/app");
    expect(socketUrl("http://127.0.0.1:4800", "t1")).toBe("ws://127.0.0.1:4800/t/t1/app");
  });

  it("reads the computer from the browser, for ⌘ on a Mac", () => {
    expect(platformOf("MacIntel")).toBe("darwin");
    expect(platformOf("macOS")).toBe("darwin");
    expect(platformOf("Win32")).toBe("win32");
    expect(platformOf("Linux x86_64")).toBe("linux");
    expect(platformOf("")).toBe("other");
  });
});
