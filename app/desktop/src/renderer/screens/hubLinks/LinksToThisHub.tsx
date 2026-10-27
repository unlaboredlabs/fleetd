// Links to this hub (Settings › Hubs, under each hub): a person makes a link key that lets their Navi on another hub open and
// follow work here, as them, optionally limited to chosen projects (hub_link_mint). The key is shown once, with this
// hub's address, to paste into that Navi's Linked hubs. Below, the links made as them, each with Revoke. Even for an
// admin this lists only their own: everyone's is on Administration › People.
import { useMemo, useState } from "react";
import type { HubLinkMintOutput, ProjectRef } from "../../../shared/contracts";
import { useData, useToolQuery } from "../../src/data/react";
import { selectProjects } from "../../src/data/selectors";
import { projectKey } from "../../src/data/store";
import { Button, Checkbox, copyText, Field, Input, Radio, RadioGroup, Text } from "../../ui";
import { HubText } from "../projects/HubText";
import { useHubRole } from "../admin/role";
import { isNavi } from "../navi/model";
import { errorText, useHubCall, useLive, useRefetch } from "../settings/hub";
import { Setting } from "../settings/parts";
import { IssuedRow, lacksLinks, LinksNeedUpdate } from "./parts";
import { labelProblem, mine, pasteText, sortIssued } from "./model";
import s from "../settings/settings.module.css";
import a from "../admin/admin.module.css";

const noInput = {};

export function LinksToThisHub() {
  return (
    <Setting
      reveal="hubs.links"
      label="Links to this hub"
      help="A link key lets your Navi on another hub open and follow work here, as you. Paste it into that Navi’s Linked hubs; revoke it here at any time."
    >
      <LinksBody />
    </Setting>
  );
}

function LinksBody() {
  const live = useLive();
  const { me } = useHubRole();
  const read = useToolQuery("hub_links_get", noInput, { enabled: live });
  const [making, setMaking] = useState(false);
  const [made, setMade] = useState<HubLinkMintOutput | null>(null);
  // Day-grained lines, so the time the page opened is close enough.
  const [now] = useState(() => Date.now());
  if (!live) return <Text tone="quiet">Connect to a hub to see and change this.</Text>;
  if (lacksLinks(read.error)) return <LinksNeedUpdate />;
  if (read.error) return <Text tone="danger">{`Couldn’t read your links: ${errorText(read.error)}`}</Text>;
  if (read.data === undefined) return <Text tone="quiet">Loading…</Text>;
  const links = sortIssued(mine(read.data.issued, me?.personId));
  const start = () => {
    setMade(null);
    setMaking(true);
  };
  return (
    <>
      {links.length === 0 && !making && made === null ? (
        <div className={s.inline}>
          <Text tone="quiet">No links to this hub yet.</Text>
          <Button size="sm" onClick={start}>
            Make a link key
          </Button>
        </div>
      ) : null}
      {made === null ? null : <MadeKey made={made} />}
      {links.length === 0 ? null : (
        <div className={a.list} role="list" aria-label="Your links to this hub">
          {links.map((l) => (
            <IssuedRow key={l.linkId} link={l} now={now} />
          ))}
        </div>
      )}
      {making ? (
        <MintForm
          onCancel={() => setMaking(false)}
          onMade={(out) => {
            setMaking(false);
            setMade(out);
          }}
        />
      ) : links.length === 0 && made === null ? null : (
        <span>
          <Button size="sm" onClick={start}>
            Make a link key
          </Button>
        </span>
      )}
    </>
  );
}

/** Every project of code on this hub, for a link's limits: a Navi is no place to send work to. */
const useLinkable = () => {
  const projects = useData(selectProjects);
  return useMemo(() => (projects ?? []).filter((p) => !isNavi(p)), [projects]);
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
      <Field label="What do you call the other hub?" description="Requests through the link read “Alex via home Navi” here." error={labelBad}>
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

/** The key just made, shown this once with this hub's address: the hub keeps only its hash. */
function MadeKey({ made }: { made: HubLinkMintOutput }) {
  const hubUrl = useData((d) => ("hub" in d.hub ? d.hub.hub : ""));
  const [copied, setCopied] = useState<boolean | null>(null);
  const text = hubUrl === "" ? made.key : pasteText(hubUrl, made.key);
  return (
    <section className={a.created} aria-label={`Link key for ${made.link.label}`}>
      <Text strong>{`Link key for ${made.link.label}`}</Text>
      <div className={a.link}>
        <Text as="code" mono size="sm">
          {made.key}
        </Text>
        <Button size="sm" onClick={() => void copyText(text).then(setCopied)}>
          {copied === true ? "Copied" : "Copy"}
        </Button>
      </div>
      <Text size="xs" tone="quiet">
        {`Shown only now. On ${made.link.label}, open your Navi’s settings, Linked hubs, and paste it${hubUrl === "" ? "" : ` with this hub’s address, ${hubUrl}, which Copy takes too`}. It acts as you here; revoke it below at any time.`}
      </Text>
      {copied === false ? (
        <Text size="xs" tone="danger">
          Couldn’t copy it. Select the key and copy it by hand.
        </Text>
      ) : null}
    </section>
  );
}
