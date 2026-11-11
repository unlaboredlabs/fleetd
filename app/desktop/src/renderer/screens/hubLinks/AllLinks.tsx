// Settings › Hub › People, Hub links: every link minted on this hub, each with the person it acts as, its limits,
// when it was last used, and Revoke. Only an admin reads everyone's (hub_links_get answers a member with their own),
// and only here: You › Hubs & devices lists a person's own.
import { useState } from "react";
import { useToolQuery } from "../../src/data/react";
import { Button } from "../../ui";
import { errorText, useLive } from "../settings/hub";
import { GroupNote, SettingsList, SettingsRow, SettingsSection } from "../settings/parts";
import { navigate } from "../shell/navigation";
import { openUpdates } from "../updates/state";
import { IssuedRow, lacksLinks } from "./parts";
import { sortIssued } from "./model";

const noInput = {};

export function AllLinks() {
  const live = useLive();
  const read = useToolQuery("hub_links_get", noInput, { enabled: live });
  const [now] = useState(() => Date.now());
  const links = read.data === undefined ? [] : sortIssued(read.data.issued);
  return (
    <SettingsSection title="Hub links" reveal="hub.links" hint="Other hubs that can see work here, each as the person who made the link.">
      {!live ? null : lacksLinks(read.error) ? (
        <SettingsRow
          title="This hub needs updating to link hubs."
          control={
            <Button size="sm" onClick={() => openUpdates(true)}>
              Update the hub
            </Button>
          }
        />
      ) : read.error ? (
        <GroupNote tone="danger">{`Couldn’t read the hub links: ${errorText(read.error)}`}</GroupNote>
      ) : read.data === undefined ? (
        <GroupNote>Loading…</GroupNote>
      ) : links.length === 0 ? (
        <SettingsRow
          title="No links to this hub yet."
          control={
            <Button size="sm" onClick={() => navigate({ id: "settings", tab: "hubs" })}>
              Make one in You › Hubs & devices
            </Button>
          }
        />
      ) : (
        <SettingsList label="Hub links">
          {links.map((l) => (
            <IssuedRow key={l.linkId} link={l} now={now} who />
          ))}
        </SettingsList>
      )}
    </SettingsSection>
  );
}
