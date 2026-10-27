// Administration › People, Hub links: every link minted on this hub, each with the person it acts as, its limits,
// when it was last used, and Revoke. Only an admin reads everyone's (hub_links_get answers a member with their own),
// and only here: Settings › Hubs lists a person's own.
import { useState } from "react";
import { useToolQuery } from "../../src/data/react";
import { Button, Text } from "../../ui";
import { errorText, useLive } from "../settings/hub";
import { navigate } from "../shell/navigation";
import { IssuedRow, lacksLinks, LinksNeedUpdate } from "./parts";
import { sortIssued } from "./model";
import a from "../admin/admin.module.css";
import s from "../settings/settings.module.css";

const noInput = {};

export function AllLinks() {
  const live = useLive();
  const read = useToolQuery("hub_links_get", noInput, { enabled: live });
  const [now] = useState(() => Date.now());
  const links = read.data === undefined ? [] : sortIssued(read.data.issued);
  return (
    <section className={a.section} aria-labelledby="admin-links">
      <div className={s.settingLabel}>
        <Text strong id="admin-links">
          Hub links
        </Text>
        <Text size="xs" tone="quiet">
          Keys that let a Navi on another hub open and follow work here, each as the person who made it. Revoking one stops it at once.
        </Text>
      </div>
      {!live ? null : lacksLinks(read.error) ? (
        <LinksNeedUpdate />
      ) : read.error ? (
        <Text tone="danger">{`Couldn’t read the hub links: ${errorText(read.error)}`}</Text>
      ) : read.data === undefined ? (
        <Text tone="quiet">Loading…</Text>
      ) : links.length === 0 ? (
        <div className={s.inline}>
          <Text size="sm" tone="quiet">
            No links to this hub yet.
          </Text>
          <Button size="sm" onClick={() => navigate({ id: "settings", tab: "hubs" })}>
            Make one in Settings
          </Button>
        </div>
      ) : (
        <div className={a.list} role="list" aria-label="Hub links">
          {links.map((l) => (
            <IssuedRow key={l.linkId} link={l} now={now} who />
          ))}
        </div>
      )}
    </section>
  );
}
