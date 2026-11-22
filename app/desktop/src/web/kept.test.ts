// A page opened again starts from the account this browser kept (cache.ts), and its session read decides whether it
// goes on (session.ts afterKeptStart).
import { describe, expect, it } from "vitest";
import { clearWebCache, keepSession, keptSession, webCache, type CacheStorage } from "./cache";
import { afterKeptStart, type SessionRead } from "./session";

const memory = (): CacheStorage => {
  const kept = new Map<string, string>();
  return {
    getItem: (k) => kept.get(k) ?? null,
    setItem: (k, v) => void kept.set(k, v),
    removeItem: (k) => void kept.delete(k),
    key: (i) => [...kept.keys()][i] ?? null,
    get length() {
      return kept.size;
    },
  };
};
const LEA = { email: "lea@example.com", teams: [{ id: "t1", name: "acme", url: "https://acme.fleetd.dev" }] };

describe("the kept account", () => {
  it("is kept for the cache's own account only, and read back as it was", () => {
    const storage = memory();
    keepSession(storage, LEA);
    expect(keptSession(storage)).toBeNull(); // no cache of this account's yet
    webCache(storage, LEA.email, ["t1"]);
    keepSession(storage, LEA);
    expect(keptSession(storage)).toEqual(LEA);
  });

  it("goes with the cache: at sign-out, and when another account signs in here", () => {
    const storage = memory();
    webCache(storage, LEA.email, ["t1"]);
    keepSession(storage, LEA);
    webCache(storage, "sam@example.com", ["t2"]);
    expect(keptSession(storage)).toBeNull();
    webCache(storage, LEA.email, ["t1"]);
    keepSession(storage, LEA);
    clearWebCache(storage);
    expect(keptSession(storage)).toBeNull();
  });

  it("keeps the teams' names and addresses, never more", () => {
    const storage = memory();
    webCache(storage, LEA.email, ["t1"]);
    keepSession(storage, { ...LEA, teams: LEA.teams.map((t) => ({ ...t, secret: "x" })) });
    expect(JSON.stringify(keptSession(storage))).not.toContain("secret");
  });
});

describe("a kept start, once its session is read", () => {
  const ok = (over: Partial<Extract<SessionRead, { ok: true }>["session"]> = {}): SessionRead => ({
    ok: true,
    session: { email: LEA.email, teams: LEA.teams, invitations: [], removed: [], ...over },
  });

  it("goes on when the session is the kept account's", () => {
    expect(afterKeptStart(LEA, ok())).toBe("keep");
  });

  it("starts again from the session when it is signed out, another account's, other teams', or a gate has something to say", () => {
    expect(afterKeptStart(LEA, { ok: false, signedOut: true })).toBe("fresh");
    expect(afterKeptStart(LEA, ok({ email: "sam@example.com" }))).toBe("fresh");
    expect(afterKeptStart(LEA, ok({ teams: [...LEA.teams, { id: "t2", name: "side", url: "https://side.fleetd.dev" }] }))).toBe("fresh");
    expect(afterKeptStart(LEA, ok({ invitations: [{ name: "side", invitedBy: "sam@example.com", role: "member", accept: "a" }] }))).toBe("fresh");
    expect(afterKeptStart(LEA, ok({ removed: ["old"] }))).toBe("fresh");
  });

  it("stays as it is, offline, when the cloud can't be reached", () => {
    expect(afterKeptStart(LEA, { ok: false, failure: { code: "offline", message: "Can't reach fleetd cloud." } })).toBe("offline");
  });
});
