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
import { when } from "../status/view";
import { setUpdatesOpen } from "../updates/state";
import { projectsLine, whoOf } from "./model";
import s from "../settings/settings.module.css";
import a from "../admin/admin.module.css";

/** A hub from before hub links answers that it has no such tool: it needs updating, not a retry. */
export const lacksLinks = (error: unknown): boolean => error instanceof CallError && lacksTool(error.error);

export function LinksNeedUpdate() {
  return (
    <div className={s.inline}>
      <Text tone="quiet">This hub needs updating to link hubs.</Text>
      <Button size="sm" onClick={() => setUpdatesOpen(true)}>
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
    <div className={a.row} role="listitem" aria-label={`Link for ${link.label}`} data-revoked={revoked || undefined}>
      <div className={a.who}>
        <div className={a.name}>
          <Text strong={!revoked} tone={revoked ? "quiet" : "default"}>{`For ${link.label}`}</Text>
          {who === true ? (
            <Text size="xs" tone="quiet">
              {`as ${whoOf(link)}`}
            </Text>
          ) : null}
        </div>
        <Text size="xs" tone="quiet">
          {`${projectsLine(link, titleOf)} · ${used} · ${made}`}
        </Text>
        {error === undefined ? null : (
          <p role="alert" className={s.alertLine}>
            <Text size="xs" tone="danger">{`Not revoked: ${error}`}</Text>
          </p>
        )}
      </div>
      <div className={a.controls}>
        {revoked ? (
          <Text size="sm" tone="quiet">
            Revoked
          </Text>
        ) : (
          <Button size="sm" variant="ghost" disabled={!live || busy} onClick={revoke}>
            {busy ? "Revoking…" : "Revoke"}
          </Button>
        )}
      </div>
    </div>
  );
}
