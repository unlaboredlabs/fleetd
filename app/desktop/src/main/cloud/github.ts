// fleetd's GitHub App installed on a cloud team (decision hosted.github-app; the self-hosted hub's own App is
// github.ts's createApp instead). The install page's `state` is made by the team for this one person, so the app never
// builds the link itself: it asks the team (POST GITHUB_INSTALL_PATH with this device's key) and opens the `url` the
// team answers. A 409 means the person's own GitHub isn't connected yet; the page shows Connect GitHub first.
import { z } from "zod";
import type { InstallGithubOutcome } from "../../shared/cloud";
import { GITHUB_INSTALL_PATH } from "../../shared/contracts";
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
