// Settings › GitHub: the person's own GitHub account, connected through the hub's App (D187, D190). The PRs agents open
// for the orders they start open as them; until they connect, a writer for their order on a repository the App reaches
// is refused with "Connect your GitHub to open this order's PRs", never run as anyone else. Connect goes through main
// (window.fleetd.github.connect): GitHub's sign-in with PKCE and a loopback redirect, the code to github_connect. The
// token stays on the hub; Disconnect (github_disconnect) revokes it at GitHub. The App itself is Administration's.
import { useState } from "react";
import type { GithubAccount, GithubAppGetOutput } from "../../../shared/contracts";
import { lacksTool } from "../../src/data/errors";
import { CallError } from "../../src/data/queries";
import { useDataLayer, useToolQuery } from "../../src/data/react";
import { Button, Text } from "../../ui";
import { dayWords } from "../google/model";
import { ConfirmRemove, Problem } from "./claudeParts";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import { PageHead, Setting } from "./parts";
import s from "./settings.module.css";

const noInput = {};

export function GithubSettings() {
  const live = useLive();
  const read = useToolQuery("github_app_get", noInput, { enabled: live });
  return (
    <div className={s.scroll} data-screen="settings.github">
      <div className={s.column}>
        <PageHead title="GitHub">The GitHub account the PRs of the orders you start open as. Nobody else&apos;s work ever opens a PR as you.</PageHead>
        {!live ? (
          <Text tone="quiet">Not connected. Connect to a hub to connect your GitHub.</Text>
        ) : read.error instanceof CallError && lacksTool(read.error.error) ? (
          <Text tone="quiet">This hub opens PRs with each machine&apos;s own gh login. Update fleetd on the hub to connect your own GitHub.</Text>
        ) : read.isLoadingError ? (
          <Text tone="danger">{errorText(read.error)}</Text>
        ) : read.data === undefined ? (
          <Text tone="quiet">Loading…</Text>
        ) : read.data.app === undefined ? (
          <Text tone="quiet">This hub has no GitHub App yet, so agents open PRs with each machine&apos;s own gh login. An admin creates it in Administration › GitHub.</Text>
        ) : (
          <Account info={read.data} />
        )}
      </div>
    </div>
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
    <Setting reveal="github.account" label="Your GitHub" help={`Signed in through the hub's App, ${info.app?.name ?? ""}. The hub keeps the token and renews it; it is never shown.`}>
      {me === undefined ? (
        <div className={s.notice} role="status">
          <div className={s.stack}>
            <Text strong>Not connected</Text>
            <Text size="sm" tone="quiet">
              Connect before your first PR: until you do, writers for your orders on the App&apos;s repositories are refused, and the lead asks you to connect.
            </Text>
          </div>
        </div>
      ) : lapsed ? (
        <div className={s.notice} role="alert">
          <div className={s.stack}>
            <Text strong>{`GitHub no longer takes your connection as ${me.login}`}</Text>
            <Text size="sm" tone="quiet">
              It was revoked on GitHub, or unused for six months. Connect again; writers for your orders are refused until you do.
            </Text>
          </div>
        </div>
      ) : (
        <Text>{`Connected as ${me.login} since ${dayWords(me.connectedAt)}. The PRs of the orders you start open as you.`}</Text>
      )}
      <span className={s.inline}>
        {me === undefined || lapsed ? (
          <Button variant="primary" disabled={waiting} onClick={() => void connect()}>
            {waiting ? "Waiting for GitHub…" : lapsed ? "Connect again" : "Connect GitHub"}
          </Button>
        ) : (
          <Button variant="ghost" onClick={() => setRemoving(true)}>
            Disconnect
          </Button>
        )}
        {waiting ? (
          <Button variant="ghost" onClick={() => void window.fleetd.github.cancel()}>
            Cancel
          </Button>
        ) : null}
      </span>
      <Problem text={problem} />
      {removing ? (
        <ConfirmRemove
          title="Disconnect your GitHub?"
          description="The hub revokes its token at GitHub and forgets it. Writers for your orders are refused until you connect again."
          action="Disconnect"
          onRemove={() => hubCall("github_disconnect", {}).then(() => refetch(["github_app_get"]))}
          onClose={() => setRemoving(false)}
        />
      ) : null}
    </Setting>
  );
}
