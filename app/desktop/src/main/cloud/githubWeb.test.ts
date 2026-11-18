// Get started's two calls of a cloud team (fleetd-cloud's src/github/web.ts and its repo list), answered here by a
// stand-in fetch: the repositories as the team lists them, `none` while the App has no installation; GitHub in one
// trip, the page the team answers taken as is (https only), and `connected` when there was nothing to do.
import { describe, expect, it } from "vitest";
import { connectGithub, githubRepos } from "./github";
import type { KeyedTeam } from "./invites";

const team: KeyedTeam = { origin: "/t/sam", key: "", name: "sam" };

const answering = (status: number, body: unknown, seen: Array<{ url: string; init?: RequestInit }> = []) =>
  ((url: string, init?: RequestInit) => {
    seen.push({ url, ...(init === undefined ? {} : { init }) });
    return Promise.resolve(
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;

describe("the team's repositories", () => {
  it("lists them as the team answers, a repository never pushed to included", async () => {
    const seen: Array<{ url: string }> = [];
    const repos = [
      {
        owner: "sam-dev",
        name: "notes-api",
        fullName: "sam-dev/notes-api",
        private: true,
        pushedAt: "2026-11-18T09:00:00Z",
        defaultBranch: "main",
        cloneUrl: "https://github.com/sam-dev/notes-api.git",
      },
      {
        owner: "sam-dev",
        name: "empty",
        fullName: "sam-dev/empty",
        private: false,
        defaultBranch: "main",
        cloneUrl: "https://github.com/sam-dev/empty.git",
      },
    ];
    const out = await githubRepos(answering(200, { repos, truncated: true }, seen), team);
    expect(seen[0]?.url).toBe("/t/sam/github/v1/repos");
    expect(out.ok && out.repos.map((r) => r.fullName)).toEqual(["sam-dev/notes-api", "sam-dev/empty"]);
    expect(out.ok && out.truncated).toBe(true);
  });

  it("says none while the App has no installation, and passes any other refusal on", async () => {
    expect(
      await githubRepos(
        answering(404, {
          code: "not_found",
          message: "fleetd's App isn't installed on this team.",
          fix: "Connect GitHub.",
        }),
        team,
      ),
    ).toEqual({
      ok: false,
      none: true,
      failure: {
        code: "not_found",
        message: "fleetd's App isn't installed on this team.",
        fix: "Connect GitHub.",
      },
    });
    const out = await githubRepos(answering(500, { code: "failed", message: "GitHub didn't answer." }), team);
    expect(out).toEqual({
      ok: false,
      failure: { code: "failed", message: "GitHub didn't answer." },
    });
    expect((await githubRepos(answering(200, { nope: 1 }), team)).ok).toBe(false);
  });
});

describe("GitHub in one trip", () => {
  it("asks the team for GitHub's page with where to come back, then goes there", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const went: string[] = [];
    const out = await connectGithub(answering(200, { url: "https://github.com/login/oauth/authorize?state=s" }, seen), team, { back: "/#/start?at=sam", install: true }, (u) => went.push(u));
    expect(out).toEqual({ ok: true });
    expect(seen[0]?.url).toBe("/t/sam/github/v1/web/connect");
    expect(seen[0]?.init?.method).toBe("POST");
    expect(JSON.parse(seen[0]?.init?.body as string)).toEqual({
      return: "/#/start?at=sam",
      install: true,
    });
    expect(went).toEqual(["https://github.com/login/oauth/authorize?state=s"]);
  });

  it("goes nowhere but https, and says connected when there was nothing to do", async () => {
    const went: string[] = [];
    expect((await connectGithub(answering(200, { url: "javascript:alert(1)" }), team, { back: "/" }, (u) => went.push(u))).ok).toBe(false);
    const done = await connectGithub(
      answering(409, {
        code: "already_connected",
        message: "Connected already.",
      }),
      team,
      { back: "/" },
      (u) => went.push(u),
    );
    expect(done).toEqual({
      ok: false,
      connected: true,
      failure: { code: "already_connected", message: "Connected already." },
    });
    expect(went).toEqual([]);
  });
});
