// The web app's calls to fleetd cloud's /web/* (session.ts), with fetch faked.
import { describe, expect, it } from "vitest";
import { readSession, signInPath, teamHubId, teamHubIds, webCall, type Fetch } from "./session";

const answering =
  (response: () => Response, seen: Array<RequestInit | undefined> = []): Fetch =>
  (_path, init) => {
    seen.push(init);
    return Promise.resolve(response());
  };

describe("readSession", () => {
  it("reads who is signed in, their teams and invitations", async () => {
    const body = { email: "lea@example.com", teams: [{ id: "t1", name: "acme", url: "https://acme.fleetd.dev" }], invitations: [{ name: "side", invitedBy: "sam@example.com", role: "member", accept: "a1" }] };
    expect(await readSession(answering(() => Response.json(body)))).toEqual({ ok: true, session: body });
    expect(await readSession(answering(() => Response.json({ email: "lea@example.com", teams: [] })))).toEqual({ ok: true, session: { email: "lea@example.com", teams: [], invitations: [] } });
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
