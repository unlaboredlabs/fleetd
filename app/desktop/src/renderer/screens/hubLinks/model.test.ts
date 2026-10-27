import { describe, expect, it } from "vitest";
import type { IssuedLink } from "../../../shared/contracts";
import { labelProblem, linkState, mine, pasteText, projectsLine, reachLine, readPasted, sortIssued, urlProblem } from "./model";

const KEY = `flk_${"abcd".repeat(13)}`;
const AT = "2026-10-27T10:00:00.000Z";
const issued = (linkId: string, extra: Partial<IssuedLink> = {}): IssuedLink => ({
  linkId,
  label: "home",
  prefix: "flk_abcdab",
  keyId: "k1",
  device: "laptop",
  createdAt: AT,
  ...extra,
});

describe("a pasted link", () => {
  it("reads the key alone, or the key with the hub's address as Links to this hub copies them", () => {
    expect(readPasted(` ${KEY}\n`)).toEqual({ key: KEY, url: undefined });
    expect(readPasted(pasteText("https://acme.example:4790/", KEY))).toEqual({ key: KEY, url: "https://acme.example:4790" });
    // A one-line box drops the newline.
    expect(readPasted(`http://devbox.tail.ts.net:4790${KEY}`)).toEqual({ key: KEY, url: "http://devbox.tail.ts.net:4790" });
    expect(readPasted("fld_not_a_link")).toEqual({ key: undefined, url: undefined });
  });

  it("asks for a label the hub takes and this Navi hasn't used, and an address", () => {
    expect(labelProblem("")).toBeUndefined();
    expect(labelProblem("x".repeat(41))).toMatch(/40/u);
    expect(labelProblem("Acme", ["acme"])).toMatch(/already/u);
    expect(labelProblem("acme", ["home"])).toBeUndefined();
    expect(urlProblem("acme")).toBeTruthy();
    expect(urlProblem("https://acme.example")).toBeUndefined();
  });
});

describe("a kept link", () => {
  const link = { label: "acme", url: "https://acme.example" };
  it("says plainly when it can't reach the hub, with its address, and when it was revoked there", () => {
    expect(linkState({ ...link, state: "ok" }).line).toBeNull();
    const down = linkState({ ...link, state: "unreachable" });
    expect(down.line).toBe("Can’t reach acme at https://acme.example.");
    expect(down.fix).toMatch(/tailnet or HTTPS/u);
    expect(linkState({ ...link, state: "unreachable", error: "Can't reach acme at https://acme.example: connection refused." }).line).toMatch(/connection refused/u);
    const gone = linkState({ ...link, state: "revoked" });
    expect(gone.word).toBe("Revoked");
    expect(gone.line).toMatch(/^Revoked on acme/u);
    expect(linkState({ ...link, state: "revoked", error: "The link hl_aaaaaaaa was revoked on this hub." }).line).toContain("acme says: “The link was revoked on this hub.”");
  });

  it("names the person it acts as and the projects it is limited to", () => {
    expect(reachLine({})).toBeNull();
    expect(reachLine({ who: "Alex" })).toBe("As Alex · every project of theirs");
    const projects = [{ projectRef: { machineId: "devbox", projectId: "shop" }, title: "Shop" }];
    expect(reachLine({ who: "Alex", projects })).toBe("As Alex · only Shop");
  });
});

describe("links minted here", () => {
  it("lists a person's own, open first, and names their projects", () => {
    const a = issued("hl_aaaaaaaa", { person: { personId: "p_1", name: "Alex" } });
    const b = issued("hl_bbbbbbbb", { person: { personId: "p_2", name: "Sam" }, createdAt: "2026-10-27T11:00:00.000Z" });
    const c = issued("hl_cccccccc", { revokedAt: "2026-10-27T12:00:00.000Z" });
    expect(mine([a, b], "p_1")).toEqual([a]);
    // Not until the hub says who you are: an admin's answer holds everyone's.
    expect(mine([a, b], undefined)).toEqual([]);
    expect(sortIssued([c, a, b]).map((l) => l.linkId)).toEqual(["hl_bbbbbbbb", "hl_aaaaaaaa", "hl_cccccccc"]);
    expect(projectsLine(a, () => undefined)).toBe("Every project");
    expect(projectsLine({ projects: [{ machineId: "devbox", projectId: "shop" }] }, () => "Shop")).toBe("Only Shop");
  });
});
