// A project's Linked hubs (Settings › Projects): the other hubs it reaches through hub links, each with the person it
// acts as there, the projects it is limited to, and whether it works, can't reach that hub or was revoked
// there; Remove; and Link a hub, which takes a link key made on the other hub (Links to this hub, in its Settings ›
// Hubs). The key goes to main, which seals it to this hub's own key (main/secret.ts) and calls hub_link_add: it
// never reaches the hub in the clear and is never shown again.
import { useState, type ReactNode } from "react";
import type { HubLink, HubLinkAddOutput, ProjectRef } from "../../../shared/contracts";
import { useDataLayer, useToolQuery } from "../../src/data/react";
import { Button, Field, Input, Text, Textarea, toast } from "../../ui";
import { HubText } from "../projects/HubText";
import { errorText, useHubCall, useLive, useRefetch } from "../settings/hub";
import { AddButton, SettingsList, SettingsListRow, SettingsRow } from "../settings/parts";
import { lacksLinks, LinksNeedUpdate } from "./parts";
import { labelProblem, linkState, reachLine, readPasted, urlProblem } from "./model";
import s from "../settings/settings.module.css";
import a from "../admin/admin.module.css";

const LINKED_LINE =
  "Other hubs this project reaches: its lead opens and follows work in their projects, as the person who made the link there. Remove a link here, or revoke it on the other hub.";

export function LinkedHubs({ project }: { project: ProjectRef }) {
  const live = useLive();
  const read = useToolQuery("hub_links_get", { project }, { enabled: live });
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const row = (control: ReactNode, body: ReactNode) => (
    <SettingsRow reveal="projects.linked" title="Linked hubs" hint={LINKED_LINE} control={control}>
      {body}
    </SettingsRow>
  );
  if (!live) return row(undefined, <Text tone="quiet">Connect to a hub to see and change this.</Text>);
  if (lacksLinks(read.error)) return row(undefined, <LinksNeedUpdate />);
  if (read.error) return row(undefined, <Text tone="danger">{`Couldn’t read the linked hubs: ${errorText(read.error)}`}</Text>);
  if (read.data === undefined) return row(undefined, <Text tone="quiet">Loading…</Text>);
  const links = read.data.links;
  return row(
    adding ? undefined : <AddButton label={links.length === 0 ? "Link a hub" : "Link another hub"} onClick={() => (setAdded(null), setAdding(true))} />,
    <>
      {links.length === 0 && !adding ? <Text tone="quiet">None yet.</Text> : null}
      {links.length === 0 ? null : (
        <SettingsList label="Linked hubs">
          {links.map((l) => (
            <LinkRow key={l.linkId} link={l} />
          ))}
        </SettingsList>
      )}
      {added === null ? null : (
        <p role="status" className={s.alertLine}>
          <Text size="sm" tone="quiet">
            {added}
          </Text>
        </p>
      )}
      {adding ? (
        <AddLink
          project={project}
          boxPubKey={read.data.boxPubKey}
          taken={links.map((l) => l.label)}
          onCancel={() => setAdding(false)}
          onAdded={(out) => {
            setAdding(false);
            const n = out.projects.length;
            setAdded(`Linked to ${out.link.label}: this project reaches ${n === 1 ? "1 project" : `${String(n)} projects`} there.`);
          }}
        />
      ) : null}
    </>,
  );
}

function LinkRow({ link }: { link: HubLink }) {
  const call = useHubCall();
  const refetch = useRefetch();
  const live = useLive();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const state = linkState(link);
  const reach = reachLine(link);
  const remove = () => {
    setBusy(true);
    setError(undefined);
    call("hub_link_remove", { linkId: link.linkId })
      .then((out) => {
        toast({ title: `Removed the link to ${link.label}`, description: out.revokedThere ? `Revoked on ${link.label} too.` : (out.next ?? undefined) });
        refetch(["hub_links_get"]);
      })
      .catch((e: unknown) => {
        setBusy(false);
        setError(errorText(e));
      });
  };
  return (
    <SettingsListRow
      name={link.label}
      label={link.label}
      data={{ "data-state": link.state }}
      meta={<span data-text="code">{link.url}</span>}
      state={{ word: state.word, tone: state.tone }}
      controls={
        <Button size="sm" variant="ghost" disabled={!live || busy} onClick={remove}>
          {busy ? "Removing…" : "Remove"}
        </Button>
      }
    >
      {reach === null ? null : (
        <Text size="sm" tone="quiet">
          {reach}
        </Text>
      )}
      {state.line === null ? null : (
        <Text size="sm" tone={state.tone}>
          <HubText>{state.line}</HubText>
        </Text>
      )}
      {state.fix === null ? null : (
        <Text size="sm" tone="quiet">
          {state.fix}
        </Text>
      )}
      {error === undefined ? null : (
        <p role="alert" className={s.alertLine}>
          <Text size="sm" tone="danger">{`Not removed: ${error}`}</Text>
        </p>
      )}
    </SettingsListRow>
  );
}

/**
 * The hub's name here, its address and the pasted key. Pasting the two lines Links to this hub copies fills the
 * address too. The key box shows dots: what was pasted is never shown.
 */
function AddLink(props: { project: ProjectRef; boxPubKey: string; taken: ReadonlyArray<string>; onCancel: () => void; onAdded: (out: HubLinkAddOutput) => void }) {
  const refetch = useRefetch();
  const { hub } = useDataLayer();
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; fix?: string | undefined } | null>(null);
  const labelBad = labelProblem(label, props.taken);
  const urlBad = urlProblem(url);
  const ready = !busy && label.trim() !== "" && url.trim() !== "" && key.trim() !== "" && labelBad === undefined && urlBad === undefined;
  // What was pasted, as it was: the key in it goes to main, and an address with it fills Its address.
  const typed = (text: string) => {
    setKey(text);
    const got = readPasted(text);
    if (got.url !== undefined && url.trim() === "") setUrl(got.url);
  };
  const pasted = readPasted(key).key ?? key.trim();
  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const out = await window.fleetd.secret.hubLink(hub, { project: props.project, label: label.trim(), url: url.trim(), boxPubKey: props.boxPubKey, key: pasted });
    setBusy(false);
    if (!out.ok) {
      setError({ message: out.error.message, fix: out.error.fix });
      return;
    }
    setKey("");
    refetch(["hub_links_get"]);
    props.onAdded(out.output as HubLinkAddOutput);
  };
  return (
    <form
      className={a.form}
      aria-label="Link a hub"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field label="Link key" description="Made on the other hub, in Settings › Hubs & devices, Links to this hub.">
        {/* A secret's characters show as dots; two lines, so the address Links to this hub copies with it pastes too. */}
        <Textarea
          mono
          className={s.secretValue}
          data-secret=""
          value={key}
          minRows={2}
          maxRows={3}
          placeholder="flk_…"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          onChange={(e) => typed(e.target.value)}
        />
      </Field>
      <Field label="Its address" description="As this hub reaches it: https, or http over a tailnet." error={urlBad}>
        <Input value={url} placeholder="https://hub.example.com" autoComplete="off" spellCheck={false} disabled={busy} onChange={(e) => setUrl(e.target.value)} />
      </Field>
      <Field label="What do you call it?" description="The lead names the hub by this: “open an order in Shop on acme”." error={labelBad}>
        <Input value={label} placeholder="acme" maxLength={41} autoComplete="off" disabled={busy} onChange={(e) => setLabel(e.target.value)} />
      </Field>
      <div className={s.actions}>
        <Button type="submit" variant="primary" disabled={!ready}>
          {busy ? "Checking the link…" : "Link hub"}
        </Button>
        <Button onClick={props.onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
      {error === null ? null : (
        <div role="alert">
          <Text size="sm" tone="danger">
            <HubText>{error.message}</HubText>
          </Text>
          {error.fix === undefined ? null : (
            <Text as="p" size="sm" tone="quiet">
              <HubText>{error.fix}</HubText>
            </Text>
          )}
        </div>
      )}
    </form>
  );
}
