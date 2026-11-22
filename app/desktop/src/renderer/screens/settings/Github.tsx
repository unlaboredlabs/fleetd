// Settings › Accounts › GitHub: the person's own GitHub account, connected through the hub's App (D187, D190). The PRs agents open
// for the orders they start open as them; until they connect, a writer for their order on a repository the App reaches
// is refused with "Connect your GitHub to open this order's PRs", never run as anyone else. Connect goes through main
// (window.fleetd.github.connect): GitHub's sign-in with PKCE and a loopback redirect, the code to github_connect. The
// token stays on the hub; Disconnect (github_disconnect) revokes it at GitHub. The App itself is Hub › Setup › GitHub's.
import { useState } from "react";
import type { GithubAccount, GithubAppGetOutput } from "../../../shared/contracts";
import { lacksTool } from "../../src/data/errors";
import { CallError } from "../../src/data/queries";
import { useDataLayer, useHub, useToolQuery } from "../../src/data/react";
import { Button } from "../../ui";
import { dayWords } from "../github/words";
import { ConfirmRemove, Problem } from "./claudeParts";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import { RowMenu, SettingsRow } from "./parts";
import { onWeb } from "../../src/web";

const noInput = {};

const HINT = "The pull requests agents open for the orders you start open as this account.";

/** GitHub, as one row of Your accounts. */
export function GithubSettings() {
  const live = useLive();
  const cloud = useHub().cloud === true;
  const read = useToolQuery("github_app_get", noInput, { enabled: live });
  const note = (line: string, tone: "quiet" | "danger" = "quiet") => <SettingsRow reveal="github" mark="off" title="GitHub" hint={HINT} line={line} lineTone={tone} />;
  if (!live) return note("Not connected. Connect to a hub to connect your GitHub.");
  if (read.error instanceof CallError && lacksTool(read.error.error)) return note("This hub opens PRs with each machine's own gh login. Update fleetd on the hub to connect your own GitHub.");
  if (read.isLoadingError) return note(errorText(read.error), "danger");
  if (read.data === undefined) return note("Loading…");
  if (read.data.app === undefined) return note(cloud ? "GitHub isn't set up on this service." : "This hub has no GitHub App yet. An admin creates it in Hub › Setup.");
  return <Account info={read.data} />;
}

function Account({ info }: { info: GithubAppGetOutput }) {
  const { hub } = useDataLayer();
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const [waiting, setWaiting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const me: GithubAccount | undefined = info.me;
  const lapsed = me?.lapsed === true;
  const connect = async () => {
    setWaiting(true);
    setProblem(null);
    if (onWeb()) {
      // The web app's GitHub in one trip: this tab goes to GitHub and comes back to this page.
      const out = await window.fleetd.cloud.connectGithub(hub, { back: `${window.location.pathname}${window.location.hash}` });
      if (out.ok) return;
      setWaiting(false);
      if (out.connected === true) refetch(["github_app_get"]);
      else setProblem(out.failure.fix === undefined ? out.failure.message : `${out.failure.message} ${out.failure.fix}`);
      return;
    }
    const out = await window.fleetd.github.connect(hub).catch((e: unknown) => ({ ok: false as const, error: { code: "failed", message: errorText(e) } }));
    setWaiting(false);
    if (!out.ok) {
      if (out.error.code !== "cancelled") setProblem(errorText(new CallError(out.error)));
      return;
    }
    refetch(["github_app_get"]);
  };
  return (
    <SettingsRow
      reveal="github.account"
      mark={me === undefined ? "off" : lapsed ? "needs" : "ready"}
      markLabel={me === undefined ? "GitHub: not connected" : lapsed ? "GitHub: connect again" : "GitHub: connected"}
      title="GitHub"
      hint={`${HINT} You sign in through the hub's App, ${info.app?.name ?? ""}. The hub keeps the token and renews it, and never shows it. GitHub drops a connection that was revoked there or unused for six months.`}
      lineTone={me !== undefined && lapsed ? "warning" : "quiet"}
      line={
        me === undefined ? (
          <span role="status">Not connected: work that opens a pull request can&apos;t start.</span>
        ) : lapsed ? (
          <span role="alert">{`GitHub no longer takes your connection as ${me.login}. Connect again to open pull requests.`}</span>
        ) : (
          `${me.login} · since ${dayWords(me.connectedAt)}`
        )
      }
      control={
        <>
          {waiting && !onWeb() ? (
            <Button variant="ghost" onClick={() => void window.fleetd.github.cancel()}>
              Cancel
            </Button>
          ) : null}
          {me === undefined || lapsed ? (
            <Button size="sm" disabled={waiting} onClick={() => void connect()}>
              {waiting ? (onWeb() ? "Opening GitHub…" : "Waiting for GitHub…") : lapsed ? "Connect again" : "Connect GitHub"}
            </Button>
          ) : (
            <RowMenu label="GitHub" items={[{ label: "Disconnect", onSelect: () => setRemoving(true), danger: true }]} />
          )}
        </>
      }
    >
      <Problem text={problem} />
      {removing ? (
        <ConfirmRemove
          title="Disconnect your GitHub?"
          description="The hub revokes its token at GitHub and forgets it. Your orders' agents can't use GitHub, and new writers are refused, until you connect again."
          action="Disconnect"
          onRemove={() => hubCall("github_disconnect", {}).then(() => refetch(["github_app_get"]))}
          onClose={() => setRemoving(false)}
        />
      ) : null}
    </SettingsRow>
  );
}
