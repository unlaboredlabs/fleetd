// Links to this hub (Settings › You › Hubs & devices, under Hub links, one per paired hub): a person makes a link key that lets
// their project on another hub open and follow work here, as them, optionally limited to chosen projects (hub_link_mint). The key is shown once, with this
// hub's address another hub reaches (hub_info's url; typed here when the hub has none), to paste into that project's
// Linked hubs. Below, the links made as them, each with Revoke. Even for an admin this lists only their own, and nothing until
// hub_info says who they are: everyone's is on Settings › Hub › People.
import { useMemo, useState, type ReactNode } from "react";
import type { HubLinkMintOutput, ProjectRef } from "../../../shared/contracts";
import { useData, useToolQuery } from "../../src/data/react";
import { selectProjects } from "../../src/data/selectors";
import { projectKey } from "../../src/data/store";
import { Button, Checkbox, copyText, Field, Input, Radio, RadioGroup, Text } from "../../ui";
import { HubText } from "../projects/HubText";
import { useHubRole } from "../admin/role";
import { isArchived } from "../projects/model";
import { errorText, useHubCall, useLive, useRefetch } from "../settings/hub";
import { AddButton, SettingsList, SettingsRow } from "../settings/parts";
import { IssuedRow, lacksLinks, LinksNeedUpdate } from "./parts";
import { labelProblem, mine, pasteText, sortIssued, urlProblem } from "./model";
import s from "../settings/settings.module.css";
import a from "../admin/admin.module.css";

const noInput = {};

/** `label`: with several hubs, which hub the links are to ("Links to Acme"). */
export function LinksToThisHub({ label = "Links to this hub" }: { label?: string } = {}) {
  const live = useLive();
  const { me, pending } = useHubRole();
  const read = useToolQuery("hub_links_get", noInput, { enabled: live });
  const [making, setMaking] = useState(false);
  const [made, setMade] = useState<HubLinkMintOutput | null>(null);
  // Day-grained lines, so the time the page opened is close enough.
  const [now] = useState(() => Date.now());
  const row = (control: ReactNode, body: ReactNode) => (
    <SettingsRow reveal="hubs.links" title={label} hint="A link lets your project on another hub work here as you. Paste its key into that project’s Linked hubs." control={control}>
      {body}
    </SettingsRow>
  );
  if (!live) return row(undefined, <Text tone="quiet">Connect to a hub to see and change this.</Text>);
  if (lacksLinks(read.error)) return row(undefined, <LinksNeedUpdate />);
  if (read.error) return row(undefined, <Text tone="danger">{`Couldn’t read your links: ${errorText(read.error)}`}</Text>);
  // Until hub_info names this person, nothing: for an admin, hub_links_get holds everyone's links.
  if (read.data === undefined || pending) return row(undefined, <Text tone="quiet">Loading…</Text>);
  const links = sortIssued(mine(read.data.issued, me?.personId));
  const start = () => {
    setMade(null);
    setMaking(true);
  };
  return row(
    making ? undefined : <AddButton label="Make a link key" onClick={start} />,
    <>
      {links.length === 0 && !making && made === null ? <Text tone="quiet">None yet.</Text> : null}
      {made === null ? null : <MadeKey made={made} />}
      {links.length === 0 ? null : (
        <SettingsList label="Your links to this hub">
          {links.map((l) => (
            <IssuedRow key={l.linkId} link={l} now={now} />
          ))}
        </SettingsList>
      )}
      {making ? (
        <MintForm
          onCancel={() => setMaking(false)}
          onMade={(out) => {
            setMaking(false);
            setMade(out);
          }}
        />
      ) : null}
    </>,
  );
}

/** Every project on this hub still in use, for a link's limits. */
const useLinkable = () => {
  const projects = useData(selectProjects);
  return useMemo(() => (projects ?? []).filter((p) => !isArchived(p)), [projects]);
};

function MintForm({ onCancel, onMade }: { onCancel: () => void; onMade: (out: HubLinkMintOutput) => void }) {
  const call = useHubCall();
  const refetch = useRefetch();
  const projects = useLinkable();
  const [label, setLabel] = useState("");
  const [limit, setLimit] = useState<"all" | "some">("all");
  const [picked, setPicked] = useState<ReadonlyArray<string>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const labelBad = labelProblem(label);
  const chosen: ProjectRef[] = projects.filter((p) => picked.includes(projectKey(p))).map((p) => ({ machineId: p.machineId, projectId: p.projectId }));
  const ready = !busy && label.trim() !== "" && labelBad === undefined && (limit === "all" || chosen.length > 0);
  const mint = () => {
    if (!ready) return;
    setBusy(true);
    setError(undefined);
    call("hub_link_mint", { label: label.trim(), ...(limit === "some" ? { projects: chosen } : {}) })
      .then((out) => {
        refetch(["hub_links_get"]);
        onMade(out);
      })
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(false));
  };
  const toggle = (key: string, on: boolean) => setPicked((now) => (on ? [...now, key] : now.filter((k) => k !== key)));
  return (
    <form
      className={a.form}
      aria-label="Make a link key"
      onSubmit={(e) => {
        e.preventDefault();
        mint();
      }}
    >
      <Field label="What do you call the other hub?" description="Requests through the link read “Alex via home” here." error={labelBad}>
        <Input value={label} placeholder="home" maxLength={41} autoComplete="off" disabled={busy} onChange={(e) => setLabel(e.target.value)} />
      </Field>
      <div className={s.settingLabel}>
        <Text size="sm" strong id="link-limit">
          What it reaches
        </Text>
        <RadioGroup value={limit} onValueChange={(v) => setLimit(v === "some" ? "some" : "all")} aria-labelledby="link-limit">
          <Radio value="all" label="Every project you can reach" />
          <Radio value="some" label="Only some projects" disabled={projects.length === 0} />
        </RadioGroup>
      </div>
      {limit === "some" ? (
        <div className={s.stack} role="group" aria-label="Projects it reaches">
          {projects.map((p) => (
            <Checkbox key={projectKey(p)} label={p.title} checked={picked.includes(projectKey(p))} disabled={busy} onCheckedChange={(on) => toggle(projectKey(p), on === true)} />
          ))}
        </div>
      ) : null}
      <div className={s.actions}>
        <Button type="submit" variant="primary" disabled={!ready}>
          {busy ? "Making…" : "Make link key"}
        </Button>
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
      {error === undefined ? null : (
        <p role="alert" className={s.alertLine}>
          <Text size="xs" tone="danger">
            <HubText>{`No link key: ${error}`}</HubText>
          </Text>
        </p>
      )}
    </form>
  );
}

/**
 * The key just made, shown this once: the hub keeps only its hash. Copy takes it with the address another hub reaches
 * this one at (hub_info's url), never the app's own, which may be this machine's. Without one, the person types it.
 */
function MadeKey({ made }: { made: HubLinkMintOutput }) {
  const info = useToolQuery("hub_info", noInput);
  const known = info.data?.url;
  const [typed, setTyped] = useState("");
  const [copied, setCopied] = useState<boolean | null>(null);
  const typedBad = urlProblem(typed);
  const address = known ?? (typed.trim() !== "" && typedBad === undefined ? typed.trim().replace(/\/+$/u, "") : undefined);
  const text = address === undefined ? made.key : pasteText(address, made.key);
  return (
    <section className={s.stack} aria-label={`Link key for ${made.link.label}`}>
      <Text>{`Link key for ${made.link.label}`}</Text>
      <div className={a.link}>
        <Text as="code" mono size="sm">
          {made.key}
        </Text>
        <Button size="sm" onClick={() => void copyText(text).then(setCopied)}>
          {copied === true ? "Copied" : "Copy"}
        </Button>
      </div>
      {known === undefined && info.data !== undefined ? (
        <Field
          label="This hub’s address, as the other hub reaches it"
          description="This hub has no address another hub can reach set: it may listen on this machine only. Type its HTTPS or tailnet address, and Copy takes it too."
          error={typedBad}
        >
          <Input value={typed} placeholder="https://hub.example.com" autoComplete="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)} />
        </Field>
      ) : null}
      <Text size="xs" tone="quiet">
        {`Shown only now. On ${made.link.label}, open your project’s settings, Linked hubs, and paste it${address === undefined ? ", with the address that hub reaches this one at" : ` with this hub’s address, ${address}, which Copy takes too`}. It acts as you here; revoke it below at any time.`}
      </Text>
      {copied === false ? (
        <Text size="xs" tone="danger">
          Couldn’t copy it. Select the key and copy it by hand.
        </Text>
      ) : null}
    </section>
  );
}
