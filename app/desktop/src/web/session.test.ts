// The web app's calls to fleetd cloud's /web/* (session.ts), with fetch faked.
import { describe, expect, it } from "vitest";
import { NOT_LISTED_YET, readSession, removedLine, removedNotice, signInPath, teamFromAddress, teamHubId, teamHubIds, untilListed, webCall, type Fetch } from "./session";

const answering =
  (response: () => Response, seen: Array<RequestInit | undefined> = []): Fetch =>
  (_path, init) => {
    seen.push(init);
    return Promise.resolve(response());
  };

describe("readSession", () => {
  it("reads who is signed in, their teams and invitations", async () => {
    const body = { email: "lea@example.com", teams: [{ id: "t1", name: "acme", url: "https://acme.fleetd.dev" }], invitations: [{ name: "side", invitedBy: "sam@example.com", role: "member", accept: "a1" }] };
    expect(await readSession(answering(() => Response.json(body)))).toEqual({ ok: true, session: { ...body, removed: [] } });
    expect(await readSession(answering(() => Response.json({ email: "lea@example.com", teams: [] })))).toEqual({ ok: true, session: { email: "lea@example.com", teams: [], invitations: [], removed: [] } });
    // Removed from teams since the last sign-in: read, for one plain line.
    const removed = await readSession(answering(() => Response.json({ email: "lea@example.com", teams: [], removed: ["acme", "side"] })));
    expect(removed.ok && removed.session.removed).toEqual(["acme", "side"]);
    expect(removedLine(["acme"])).toBe("You were removed from acme.");
    expect(removedLine(["acme", "side"])).toBe("You were removed from acme, side.");
  });

  it("keeps whom the person was removed from until a screen says it: every gate, then never the app after a gate did", () => {
    // Removed from their only team: the no-team gate says it, a second read (the cloud has forgotten) still does,
    // and the app made from there doesn't say it again.
    const gate = removedNotice();
    expect(gate.read({ removed: ["acme"] })).toBe("You were removed from acme.");
    gate.shown();
    expect(gate.read({ removed: [] })).toBe("You were removed from acme.");
    gate.shown();
    expect(gate.app()).toBeUndefined();
    expect(gate.read({ removed: [] })).toBeUndefined();
    // Still in another team, no gate: the app says it once.
    const app = removedNotice();
    expect(app.read({ removed: ["acme", "side"] })).toBe("You were removed from acme, side.");
    expect(app.app()).toBe("You were removed from acme, side.");
    expect(app.app()).toBeUndefined();
    // Never removed: nothing anywhere.
    const none = removedNotice();
    expect(none.read({ removed: [] })).toBeUndefined();
    none.shown();
    expect(none.app()).toBeUndefined();
  });

  it("is signed out on a 401, and says what went wrong otherwise, never a bare fetch error", async () => {
    expect(await readSession(answering(() => new Response(null, { status: 401 })))).toEqual({ ok: false, signedOut: true });
    expect(await readSession(() => Promise.reject(new TypeError("Failed to fetch")))).toEqual({ ok: false, failure: { code: "offline", message: "Can't reach fleetd cloud.", fix: "Check your connection, then try again." } });
    expect(await readSession(answering(() => Response.json({ code: "limit", message: "Too many sign-ins." }, { status: 429 })))).toEqual({ ok: false, failure: { code: "limit", message: "Too many sign-ins." } });
    const odd = await readSession(answering(() => Response.json({ email: 3 })));
    expect(!odd.ok && odd.signedOut !== true ? odd.failure.message : "").toMatch(/doesn't read/u);
  });
});

describe("webCall", () => {
  it("sends the cookie on this origin only, with the web header, and follows no redirect", async () => {
    const seen: Array<RequestInit | undefined> = [];
    await webCall(answering(() => new Response(null, { status: 204 }), seen), "POST", "/web/accept", { json: { accept: "a1" } });
    const init = seen[0];
    expect(init?.credentials).toBe("same-origin");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("x-fleetd-web")).toBe("1");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(init?.body).toBe('{"accept":"a1"}');
  });
});

describe("signInPath and teamHubId", () => {
  it("comes back to a path of this origin only", () => {
    expect(signInPath("/")).toBe("/web/sign-in");
    expect(signInPath("/#/project/devbox/p1")).toBe("/web/sign-in?return=%2F%23%2Fproject%2Fdevbox%2Fp1");
    expect(signInPath("//evil.example/x")).toBe("/web/sign-in");
    expect(signInPath("https://evil.example/")).toBe("/web/sign-in");
  });

  it("asks for WorkOS's sign-up form for Make an account, the way back kept", () => {
    expect(signInPath("/", true)).toBe("/web/sign-in?screen_hint=sign-up");
    expect(signInPath("/#/settings/general", true)).toBe("/web/sign-in?return=%2F%23%2Fsettings%2Fgeneral&screen_hint=sign-up");
    expect(signInPath("//evil.example/x", true)).toBe("/web/sign-in?screen_hint=sign-up");
  });

  it("makes a team's id a hub id the routes take", () => {
    expect(teamHubId("3F2B9C1E-0000-4000-8000-000000000001")).toBe("3f2b9c1e00004000");
    expect(teamHubId("---")).toBe("team");
  });

  it("keeps two teams whose ids begin alike apart, in any order, and leaves the rest as they were", () => {
    const ids = teamHubIds(["acme-corporation-eu", "acme-corporation-us", "a-b", "ab", "side"]);
    const values = [...ids.values()];
    expect(new Set(values).size).toBe(5);
    for (const id of values) expect(id).toMatch(/^[a-z0-9]{1,16}$/u);
    expect(ids.get("side")).toBe("side");
    const again = teamHubIds(["ab", "side", "acme-corporation-us", "a-b", "acme-corporation-eu"]);
    expect([...again].toSorted()).toEqual([...ids].toSorted());
  });
});

describe("teamFromAddress", () => {
  const hubs = new Map([["3f2b9c1e-0000-4000-8000-000000000001", "3f2b9c1e00004000"]]);
  it("opens the team the address names, on the screen its hash asks for, and takes the parameter away", () => {
    expect(teamFromAddress({ search: "?team=3f2b9c1e-0000-4000-8000-000000000001", hash: "" }, hubs)).toEqual({ search: "", hash: "#/?at=3f2b9c1e00004000" });
    const billing = teamFromAddress({ search: "?billing=paid&team=3f2b9c1e-0000-4000-8000-000000000001", hash: "#/settings/hub/billing" }, hubs);
    expect(billing?.search).toBe("?billing=paid");
    expect(billing?.hash).toContain("settings/hub/billing");
    expect(billing?.hash).toContain("at=3f2b9c1e00004000");
  });
  it("leaves the screen alone for a team that isn't the account's, and an address naming none", () => {
    expect(teamFromAddress({ search: "?team=someone-else", hash: "#/settings/hub/billing" }, hubs)).toEqual({ search: "", hash: "#/settings/hub/billing" });
    expect(teamFromAddress({ search: "?github=connected", hash: "#/" }, hubs)).toBeNull();
  });
});

describe("after Make a team", () => {
  const session = (teams: number) => ({ ok: true as const, session: { email: "lee@example.com", teams: Array.from({ length: teams }, (_, i) => ({ id: `t${String(i)}`, name: "lee", url: "https://lee.fleetd.dev" })), invitations: [], removed: [] } });
  const reads = (answers: Array<Awaited<ReturnType<typeof readSession>>>) => {
    let i = 0;
    return () => {
      const next = answers[Math.min(i++, answers.length - 1)];
      if (next === undefined) throw new Error("no answer");
      return Promise.resolve(next);
    };
  };

  it("reads again with a short backoff until the session lists the team", async () => {
    const waited: number[] = [];
    const out = await untilListed(reads([session(0), session(0), session(1)]), (ms) => (waited.push(ms), Promise.resolve()));
    expect(out).toBe("listed");
    expect(waited).toEqual([500, 1000]);
  });

  it("gives up after about 7.5 s with a line that turns the button back on, or follows a sign-out", async () => {
    const waited: number[] = [];
    expect(await untilListed(reads([session(0)]), (ms) => (waited.push(ms), Promise.resolve()))).toBe("not_yet");
    expect(waited).toEqual([500, 1000, 2000, 4000]);
    expect(NOT_LISTED_YET.message).toBe("Your workspace is made, but fleetd cloud isn't showing it yet.");
    expect(await untilListed(reads([session(0), { ok: false, signedOut: true }]), () => Promise.resolve())).toBe("signed_out");
  });
});
