// Settings › Hub › People's invites: a link for someone new (invite_create with a name and role), shown once with
// Copy, and an open invite's row with Revoke (invite_revoke). The link is today's fleetd://pair link, bound to the person
// and good for 7 days; their app opens it and pairs as them.
import { Mail } from "lucide-react";
import { useId, useState } from "react";
import type { HubRole, Invite, InviteCreateOutput, Person } from "../../../shared/contracts";
import { Button, copyText, Input, Radio, RadioGroup, Text, Truncate } from "../../ui";
import { useHub, useSeveralHubs } from "../../src/data/react";
import { errorText, useHubCall, useLive, useRefetch } from "../settings/hub";
import { expiresLine, nameProblem, ROLE_HELP, roleWord } from "./model";
import { SettingsListRow, SettingsRow, SettingsSection } from "../settings/parts";
import { useReveal } from "../settings/search";
import s from "../settings/settings.module.css";
import a from "./admin.module.css";

/** The roles an invite offers; owners are made from People, by an owner. */
const INVITE_ROLES: ReadonlyArray<HubRole> = ["member", "admin"];

/** Invite someone, opened by People's plus: its form and the link just made. */
export function InviteSection() {
  const [created, setCreated] = useState<InviteCreateOutput | null>(null);
  const ref = useReveal<HTMLDivElement>("hub.invite");
  return (
    <div ref={ref}>
      <SettingsSection title="Invite someone" intro="A link they open in the fleetd app to join this hub as themselves. It works once, within 7 days.">
        <InviteForm onCreated={setCreated} />
        {created === null ? null : <CreatedLink created={created} />}
      </SettingsSection>
    </div>
  );
}

/** Who made an invite, as its row says it: "by you", "by Sam", "from the hub machine". */
export const invitedBy = (i: Invite, me: Person | undefined): string =>
  i.createdBy === undefined ? "from the hub machine" : i.createdBy.personId === me?.personId ? "by you" : `by ${i.createdBy.name}`;

function InviteForm({ onCreated }: { onCreated: (out: InviteCreateOutput) => void }) {
  const call = useHubCall();
  // With several hubs the button names the hub the invite is for, so it is never minted on the wrong one.
  const hub = useHub();
  const several = useSeveralHubs();
  const refetch = useRefetch();
  const [name, setName] = useState("");
  const [role, setRole] = useState<HubRole>("member");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const problem = nameProblem(name);
  const nameId = useId();
  const create = () => {
    setTried(true);
    if (problem !== undefined) return;
    setBusy(true);
    setError(undefined);
    call("invite_create", { name: name.trim(), role })
      .then((out) => {
        onCreated(out);
        setName("");
        setTried(false);
        refetch(["people_list", "hub_info"]);
      })
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(false));
  };
  return (
    <form
      aria-label="Invite someone"
      onSubmit={(e) => {
        e.preventDefault();
        create();
      }}
    >
      <SettingsRow
        title={<label htmlFor={nameId}>Name</label>}
        label="Name"
        line={tried && problem !== undefined ? problem : undefined}
        lineTone="danger"
        control={<Input id={nameId} className={a.inviteName} value={name} placeholder="Alice" autoComplete="off" onChange={(e) => setName(e.target.value)} />}
      />
      <SettingsRow title="Role" titleId="invite-role">
        <RadioGroup value={role} onValueChange={(v) => setRole(v)} aria-labelledby="invite-role">
          {INVITE_ROLES.map((r) => (
            <Radio key={r} value={r} label={roleWord(r)} description={ROLE_HELP[r]} />
          ))}
        </RadioGroup>
      </SettingsRow>
      <SettingsRow
        title={several ? `For ${hub.label}` : "The link"}
        line={error === undefined ? "Shown once, to send them yourself." : <span role="alert">{`No invite: ${error}`}</span>}
        lineTone={error === undefined ? "quiet" : "danger"}
        control={
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Creating…" : several ? `Create invite link to ${hub.label}` : "Create invite link"}
          </Button>
        }
      />
    </form>
  );
}

/** The link just made, shown this once: the hub keeps only its hash. */
function CreatedLink({ created }: { created: InviteCreateOutput }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  const name = created.invite.person.name;
  return (
    <section className={a.created} aria-label={`Invite link for ${name}`}>
      <Text>{`Invite link for ${name}`}</Text>
      <div className={a.link}>
        <Truncate mono size="sm">
          {created.link}
        </Truncate>
        <Button variant="secondary" onClick={() => void copyText(created.link).then(setCopied)}>
          {copied === true ? "Copied" : "Copy link"}
        </Button>
      </div>
      <Text size="sm" tone="quiet">
        {`Shown only now. Send it to ${name}; their fleetd app opens it and joins. Without the link, they enter ${created.hubUrl} and the code ${created.code}.`}
      </Text>
      {copied === false ? (
        <Text size="sm" tone="danger">
          Couldn't copy it. Select the link and copy it by hand.
        </Text>
      ) : null}
    </section>
  );
}

/** An open invite for one more device of someone already on the hub, with Revoke. */
export function OpenInvite({ invite: i, role, me }: { invite: Invite; role: HubRole | undefined; me: Person | undefined }) {
  const live = useLive();
  const call = useHubCall();
  const refetch = useRefetch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // Days-grained, so the time the page opened is close enough.
  const [now] = useState(() => Date.now());
  const revoke = () => {
    setBusy(true);
    setError(undefined);
    call("invite_revoke", { inviteId: i.inviteId })
      .then(() => refetch(["people_list", "hub_info"]))
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(false));
  };
  return (
    <SettingsListRow
      label={i.person.name}
      icon={<Mail />}
      name={i.person.name}
      meta={role === undefined ? undefined : roleWord(role)}
      controls={
        <Button variant="ghost" disabled={!live || busy} onClick={revoke}>
          Revoke
        </Button>
      }
    >
      <Text size="sm" tone="quiet">
        {`${expiresLine(i.expiresAt, now)}. Invited ${invitedBy(i, me)}.`}
      </Text>
      {error === undefined ? null : (
        <p role="alert" className={s.alertLine}>
          <Text size="sm" tone="danger">{`Not revoked: ${error}`}</Text>
        </p>
      )}
    </SettingsListRow>
  );
}
