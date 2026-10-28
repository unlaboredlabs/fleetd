// A Navi's Linked hubs (Settings › Projects, for a Navi): the other hubs it reaches through hub links, each with the
// person it acts as there, the projects it is limited to, and whether it works, can't reach that hub or was revoked
// there; Remove; and Link a hub, which takes a link key made on the other hub (Links to this hub, in its Settings ›
// Hubs). The key goes to main, which seals it to this hub's own key (main/secret.ts) and calls hub_link_add: it
// never reaches the hub in the clear and is never shown again.
import { useState } from "react";
import type { HubLink, HubLinkAddOutput, ProjectRef } from "../../../shared/contracts";
import { useDataLayer, useToolQuery } from "../../src/data/react";
import { Button, Field, Input, Text, Textarea, toast } from "../../ui";
import { HubText } from "../projects/HubText";
import { errorText, useHubCall, useLive, useRefetch } from "../settings/hub";
import { Setting } from "../settings/parts";
import { lacksLinks, LinksNeedUpdate } from "./parts";
import { labelProblem, linkState, reachLine, readPasted, urlProblem } from "./model";
import s from "../settings/settings.module.css";
import a from "../admin/admin.module.css";

export function LinkedHubs({ navi }: { navi: ProjectRef }) {
  return (
    <Setting
      reveal="projects.links"
      label="Linked hubs"
      help="Other hubs this Navi reaches: it opens and follows work in their projects, as the person who made the link there. Remove a link here, or revoke it on the other hub."
    >
      <LinkedBody navi={navi} />
    </Setting>
  );
}

function LinkedBody({ navi }: { navi: ProjectRef }) {
  const live = useLive();
  const read = useToolQuery("hub_links_get", { navi }, { enabled: live });
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  if (!live) return <Text tone="quiet">Connect to a hub to see and change this.</Text>;
  if (lacksLinks(read.error)) return <LinksNeedUpdate />;
  if (read.error) return <Text tone="danger">{`Couldn’t read the linked hubs: ${errorText(read.error)}`}</Text>;
  if (read.data === undefined) return <Text tone="quiet">Loading…</Text>;
  const links = read.data.links;
  const form = (
    <AddLink
      navi={navi}
      boxPubKey={read.data.boxPubKey}
      taken={links.map((l) => l.label)}
      onCancel={() => setAdding(false)}
      onAdded={(out) => {
        setAdding(false);
        const n = out.projects.length;
        setAdded(`Linked to ${out.link.label}: this Navi reaches ${n === 1 ? "1 project" : `${String(n)} projects`} there.`);
      }}
    />
  );
  return (
    <>
      {links.length === 0 && !adding ? (
        <div className={s.inline}>
          <Text tone="quiet">No linked hubs yet.</Text>
          <Button size="sm" onClick={() => (setAdded(null), setAdding(true))}>
            Link a hub
          </Button>
        </div>
      ) : null}
      {links.length === 0 ? null : (
        <div className={a.list} role="list" aria-label="Linked hubs">
          {links.map((l) => (
            <LinkRow key={l.linkId} link={l} />
          ))}
        </div>
      )}
      {added === null ? null : (
        <p role="status" className={s.alertLine}>
          <Text size="sm" tone="quiet">
            {added}
          </Text>
        </p>
      )}
      {adding ? (
        form
      ) : links.length === 0 ? null : (
        <span>
          <Button size="sm" onClick={() => (setAdded(null), setAdding(true))}>
            Link another hub
          </Button>
        </span>
      )}
    </>
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
    <div className={a.row} role="listitem" aria-label={link.label} data-state={link.state}>
      <div className={a.who}>
        <div className={a.name}>
          <Text strong>{link.label}</Text>
          <Text size="xs" tone="quiet" mono>
            {link.url}
          </Text>
        </div>
        {reach === null ? null : (
          <Text size="xs" tone="quiet">
            {reach}
          </Text>
        )}
        {state.line === null ? null : (
          <Text size="xs" tone={state.tone}>
            <HubText>{state.line}</HubText>
          </Text>
        )}
        {state.fix === null ? null : (
          <Text size="xs" tone="quiet">
            {state.fix}
          </Text>
        )}
        {error === undefined ? null : (
          <p role="alert" className={s.alertLine}>
            <Text size="xs" tone="danger">{`Not removed: ${error}`}</Text>
          </p>
        )}
      </div>
      <div className={a.controls}>
        <Text size="sm" tone={state.tone}>
          {state.word}
        </Text>
        <Button size="sm" variant="ghost" disabled={!live || busy} onClick={remove}>
          {busy ? "Removing…" : "Remove"}
        </Button>
      </div>
    </div>
  );
}

/**
 * The hub's name here, its address and the pasted key. Pasting the two lines Links to this hub copies fills the
 * address too. The key box shows dots: what was pasted is never shown.
 */
function AddLink(props: { navi: ProjectRef; boxPubKey: string; taken: ReadonlyArray<string>; onCancel: () => void; onAdded: (out: HubLinkAddOutput) => void }) {
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
    const out = await window.fleetd.secret.hubLink(hub, { navi: props.navi, label: label.trim(), url: url.trim(), boxPubKey: props.boxPubKey, key: pasted });
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
      <Field label="Link key" description="Made on the other hub, in Settings › Connections › Hubs, Links to this hub. It is sealed to this hub and never shown again.">
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
      <Field label="What do you call it?" description="The Navi names the hub by this: “open an order in Shop on acme”." error={labelBad}>
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
