// fleetd's GitHub App installed on a cloud team (decision hosted.github-app; the self-hosted hub's own App is
// github.ts's createApp instead). The install page's `state` is made by the team for this one person, so the app never
// builds the link itself: it asks the team (POST GITHUB_INSTALL_PATH with this device's key) and opens the `url` the
// team answers. A 409 means the person's own GitHub isn't connected yet; the page shows Connect GitHub first.
import { z } from "zod";
import type { ConnectGithubOutcome, GithubReposOutcome, InstallGithubOutcome } from "../../shared/cloud";
import { GITHUB_INSTALL_PATH, GITHUB_REPOS_PATH, GITHUB_WEB_CONNECT_PATH } from "../../shared/contracts";
import type { Fetch } from "../pairing/hubHttp";
import { call, odd, type KeyedTeam } from "./invites";

const Install = z.object({ url: z.string().min(1).max(8192) });

/** GitHub's install page, only over https: the team's answer is opened in the browser as is. */
const pageOf = (url: string): string | null => {
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
};

export const installGithub = async (fetch: Fetch, team: KeyedTeam, open: (url: string) => Promise<void>): Promise<InstallGithubOutcome> => {
  const answer = await call(fetch, team, "POST", GITHUB_INSTALL_PATH);
  if (!answer.ok) return { ok: false, ...(answer.status === 409 ? { connectFirst: true as const } : {}), failure: answer.failure };
  const got = Install.safeParse(answer.body);
  const url = got.success ? pageOf(got.data.url) : null;
  if (url === null) return odd(team);
  try {
    await open(url);
  } catch (error) {
    return { ok: false, failure: { code: "", message: `The browser didn't open: ${String(error)}` } };
  }
  return { ok: true };
};

const Repo = z.object({
  owner: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  fullName: z.string().min(1).max(201),
  private: z.boolean(),
  pushedAt: z.string().max(40).optional(),
  cloneUrl: z.string().min(1).max(500),
});
const Repos = z.object({ repos: z.array(Repo).max(10_000), truncated: z.boolean().optional() });

/** The repositories the App reaches for the team (GITHUB_REPOS_PATH), newest push first; `none` while it has no installation. */
export const githubRepos = async (fetch: Fetch, team: KeyedTeam): Promise<GithubReposOutcome> => {
  const answer = await call(fetch, team, "GET", GITHUB_REPOS_PATH);
  if (!answer.ok) return { ok: false, ...(answer.status === 404 ? { none: true as const } : {}), failure: answer.failure };
  const got = Repos.safeParse(answer.body);
  return got.success ? { ok: true, repos: got.data.repos, truncated: got.data.truncated === true } : odd(team);
};

/**
 * The web app's GitHub in one trip (GITHUB_WEB_CONNECT_PATH): the team answers GitHub's page, which `go` navigates
 * this tab to; `back` is where GitHub's trip ends, a path of this page's own. 409: connected, and installed, already.
 */
export const connectGithub = async (fetch: Fetch, team: KeyedTeam, request: { readonly back: string; readonly install?: boolean }, go: (url: string) => void): Promise<ConnectGithubOutcome> => {
  const answer = await call(fetch, team, "POST", GITHUB_WEB_CONNECT_PATH, { return: request.back, ...(request.install === undefined ? {} : { install: request.install }) });
  if (!answer.ok) return { ok: false, ...(answer.status === 409 ? { connected: true as const } : {}), failure: answer.failure };
  const got = Install.safeParse(answer.body);
  const url = got.success ? pageOf(got.data.url) : null;
  if (url === null) return odd(team);
  go(url);
  return { ok: true };
};
