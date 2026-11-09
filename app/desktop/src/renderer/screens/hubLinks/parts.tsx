// What Linked hubs, Links to this hub and Hub › People's hub links share: the word for a hub too old to link hubs,
// and a row for a link minted here, with Revoke (hub_link_revoke; the hub lets its person or an admin).
import { useState } from "react";
import type { IssuedLink, ProjectRef } from "../../../shared/contracts";
import { lacksTool } from "../../src/data/errors";
import { CallError } from "../../src/data/queries";
import { useData } from "../../src/data/react";
import { projectKey } from "../../src/data/store";
import { Button, Text } from "../../ui";
import { errorText, useHubCall, useLive, useRefetch } from "../settings/hub";
import { when } from "../live/when";
import { openUpdates } from "../updates/state";
import { SettingsListRow } from "../settings/parts";
import { projectsLine, whoOf } from "./model";
import s from "../settings/settings.module.css";

/** A hub from before hub links answers that it has no such tool: it needs updating, not a retry. */
export const lacksLinks = (error: unknown): boolean => error instanceof CallError && lacksTool(error.error);

export function LinksNeedUpdate() {
  return (
    <div className={s.inline}>
      <Text tone="quiet">This hub needs updating to link hubs.</Text>
      <Button size="sm" onClick={() => openUpdates(true)}>
        Update the hub
      </Button>
    </div>
  );
}

/** A project's title on this hub, for a link's limits. */
export const useTitleOf = (): ((p: ProjectRef) => string | undefined) => {
  const projects = useData((d) => d.projects);
  return (p) => projects[projectKey(p)]?.title;
};

/**
 * One link minted on this hub: what its person called the other hub, the projects it is limited to, when it was last
 * used, and Revoke. `who` adds its person (Hub › People lists everyone's).
 */
export function IssuedRow({ link, now, who }: { link: IssuedLink; now: number; who?: boolean }) {
  const live = useLive();
  const call = useHubCall();
  const refetch = useRefetch();
  const titleOf = useTitleOf();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const revoked = link.revokedAt !== undefined;
  const revoke = () => {
    setBusy(true);
    setError(undefined);
    call("hub_link_revoke", { linkId: link.linkId })
      .then(() => refetch(["hub_links_get"]))
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(false));
  };
  const used = link.revokedAt !== undefined ? `Revoked ${when(link.revokedAt, now)}` : link.lastUsedAt === undefined ? "Not used yet" : `Last used ${when(link.lastUsedAt, now)}`;
  const made = `Made ${when(link.createdAt, now)} on ${link.device}`;
  return (
    <SettingsListRow
      name={`For ${link.label}`}
      label={`Link for ${link.label}`}
      data={{ "data-revoked": revoked ? "" : undefined }}
      meta={who === true ? `as ${whoOf(link)}` : undefined}
      {...(revoked ? { state: { word: "Revoked", tone: "quiet" as const } } : {})}
      controls={
        revoked ? undefined : (
          <Button size="sm" variant="ghost" disabled={!live || busy} onClick={revoke}>
            {busy ? "Revoking…" : "Revoke"}
          </Button>
        )
      }
    >
      <Text size="sm" tone="quiet">
        {`${projectsLine(link, titleOf)} · ${used} · ${made}`}
      </Text>
      {error === undefined ? null : (
        <p role="alert" className={s.alertLine}>
          <Text size="sm" tone="danger">{`Not revoked: ${error}`}</Text>
        </p>
      )}
    </SettingsListRow>
  );
}
