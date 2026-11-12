// Settings › Your accounts › GitHub: the person's own GitHub account, connected through the hub's App (D187, D190). The PRs agents open
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
import { GroupNote, SettingsRow, SettingsSection } from "./parts";

const noInput = {};

export function GithubSettings() {
  const live = useLive();
  const cloud = useHub().cloud === true;
  const read = useToolQuery("github_app_get", noInput, { enabled: live });
  return (
    <SettingsSection title="GitHub" reveal="github" hint="The pull requests agents open for the orders you start open as this account.">
      {!live ? (
        <GroupNote>Not connected. Connect to a hub to connect your GitHub.</GroupNote>
      ) : read.error instanceof CallError && lacksTool(read.error.error) ? (
        <GroupNote>This hub opens PRs with each machine&apos;s own gh login. Update fleetd on the hub to connect your own GitHub.</GroupNote>
      ) : read.isLoadingError ? (
        <GroupNote tone="danger">{errorText(read.error)}</GroupNote>
      ) : read.data === undefined ? (
        <GroupNote>Loading…</GroupNote>
      ) : read.data.app === undefined ? (
        <GroupNote>{cloud ? "GitHub isn't set up on this service." : "This hub has no GitHub App yet. An admin creates it in Hub › Setup."}</GroupNote>
      ) : (
        <Account info={read.data} />
      )}
    </SettingsSection>
  );
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
      title="Your GitHub"
      hint={`You sign in through the hub's App, ${info.app?.name ?? ""}. The hub keeps the token and renews it, and never shows it. GitHub drops a connection that was revoked there or unused for six months.`}
      lineTone={me !== undefined && lapsed ? "warning" : "quiet"}
      line={
        me === undefined ? (
          <span role="status">Not connected: work that opens a pull request can&apos;t start.</span>
        ) : lapsed ? (
          <span role="alert">{`GitHub no longer takes your connection as ${me.login}. Connect again to open pull requests.`}</span>
        ) : (
          `Connected as ${me.login} since ${dayWords(me.connectedAt)}.`
        )
      }
      control={
        <>
          {waiting ? (
            <Button variant="ghost" onClick={() => void window.fleetd.github.cancel()}>
              Cancel
            </Button>
          ) : null}
          {me === undefined || lapsed ? (
            <Button variant="primary" disabled={waiting} onClick={() => void connect()}>
              {waiting ? "Waiting for GitHub…" : lapsed ? "Connect again" : "Connect GitHub"}
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => setRemoving(true)}>
              Disconnect
            </Button>
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
