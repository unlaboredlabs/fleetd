// Administration → People's invites: a link for someone new (invite_create with a name and role), shown once with
// Copy, and the invites still open, each with Revoke (invite_revoke). The link is today's fleetd://pair link, bound to the person
// and good for 7 days; their app opens it and pairs as them.
import { UserPlus } from "lucide-react";
import { useState } from "react";
import type { HubRole, Invite, InviteCreateOutput, Person } from "../../../shared/contracts";
import { Button, copyText, Field, Input, Radio, RadioGroup, Text, Truncate } from "../../ui";
import { useHub, useSeveralHubs } from "../../src/data/react";
import { errorText, useHubCall, useLive, useRefetch } from "../settings/hub";
import { expiresLine, nameProblem, openInvites, ROLE_HELP, roleWord } from "./model";
import { usePeople } from "./usePeople";
import s from "../settings/settings.module.css";
import a from "./admin.module.css";

/** The roles an invite offers; owners are made from People, by an owner. */
const INVITE_ROLES: ReadonlyArray<HubRole> = ["member", "admin"];

/** Invite someone, the link just made, and the invites waiting to join; below People's list, on a hub that has people. */
export function Invites({ me }: { me: Person | undefined }) {
  const read = usePeople();
  const [inviting, setInviting] = useState(false);
  const [created, setCreated] = useState<InviteCreateOutput | null>(null);
  // Days-grained, so the time the page opened is close enough.
  const [now] = useState(() => Date.now());
  const roleOf = (i: Invite): HubRole | undefined => read.data?.people.find((p) => p.personId === i.person.personId)?.role;
  const open = read.data === undefined ? [] : openInvites(read.data.invites);
  return (
    <>
      {inviting ? (
        <section className={a.section} aria-labelledby="invite-someone">
          <Text strong id="invite-someone">
            Invite someone
          </Text>
          <Text size="xs" tone="quiet">
            A link they open in the fleetd app to join this hub as themselves. It works once, within 7 days.
          </Text>
          <InviteForm onCreated={setCreated} />
          {created === null ? null : <CreatedLink created={created} />}
        </section>
      ) : (
        <span>
          <Button icon={<UserPlus size={14} />} onClick={() => setInviting(true)}>
            Invite someone
          </Button>
        </span>
      )}
      {open.length === 0 && read.data !== undefined ? null : (
        <section className={a.section} aria-labelledby="invites-open">
          <Text strong id="invites-open">
            Waiting to join
          </Text>
          {read.error ? (
            <Text tone="danger">{`Couldn't read the invites: ${errorText(read.error)}`}</Text>
          ) : read.data === undefined ? (
            <Text tone="quiet">Loading…</Text>
          ) : (
            <div className={a.list} role="list" aria-label="Open invites">
              {open.map((i) => (
                <OpenInvite key={i.inviteId} invite={i} role={roleOf(i)} me={me} now={now} />
              ))}
            </div>
          )}
        </section>
      )}
    </>
  );
}

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
      className={a.form}
      aria-label="Invite someone"
      onSubmit={(e) => {
        e.preventDefault();
        create();
      }}
    >
      <Field label="Name" description="How the hub and the leads name them: “Alice writes”." error={tried ? problem : undefined}>
        <Input value={name} placeholder="Alice" autoComplete="off" onChange={(e) => setName(e.target.value)} />
      </Field>
      <div className={s.settingLabel}>
        <Text size="sm" strong id="invite-role">
          Role
        </Text>
        <RadioGroup value={role} onValueChange={(v) => setRole(v)} aria-labelledby="invite-role">
          {INVITE_ROLES.map((r) => (
            <Radio key={r} value={r} label={roleWord(r)} description={ROLE_HELP[r]} />
          ))}
        </RadioGroup>
      </div>
      <div className={s.actions}>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "Creating…" : several ? `Create invite link to ${hub.label}` : "Create invite link"}
        </Button>
      </div>
      {error === undefined ? null : (
        <p role="alert" className={s.alertLine}>
          <Text size="xs" tone="danger">{`No invite: ${error}`}</Text>
        </p>
      )}
    </form>
  );
}

/** The link just made, shown this once: the hub keeps only its hash. */
function CreatedLink({ created }: { created: InviteCreateOutput }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  const name = created.invite.person.name;
  return (
    <section className={a.created} aria-label={`Invite link for ${name}`}>
      <Text strong>{`Invite link for ${name}`}</Text>
      <div className={a.link}>
        <Truncate mono size="sm">
          {created.link}
        </Truncate>
        <Button size="sm" onClick={() => void copyText(created.link).then(setCopied)}>
          {copied === true ? "Copied" : "Copy link"}
        </Button>
      </div>
      <Text size="xs" tone="quiet">
        {`Shown only now. Send it to ${name}; their fleetd app opens it and joins. Without the link, they enter ${created.hubUrl} and the code ${created.code}.`}
      </Text>
      {copied === false ? (
        <Text size="xs" tone="danger">
          Couldn't copy it. Select the link and copy it by hand.
        </Text>
      ) : null}
    </section>
  );
}

function OpenInvite({ invite: i, role, me, now }: { invite: Invite; role: HubRole | undefined; me: Person | undefined; now: number }) {
  const live = useLive();
  const call = useHubCall();
  const refetch = useRefetch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const revoke = () => {
    setBusy(true);
    setError(undefined);
    call("invite_revoke", { inviteId: i.inviteId })
      .then(() => refetch(["people_list", "hub_info"]))
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(false));
  };
  const by = i.createdBy === undefined ? "from the hub machine" : i.createdBy.personId === me?.personId ? "by you" : `by ${i.createdBy.name}`;
  return (
    <div className={a.row} role="listitem" aria-label={i.person.name}>
      <div className={a.who}>
        <div className={a.name}>
          <Text strong>{i.person.name}</Text>
          {role === undefined ? null : (
            <Text size="xs" tone="quiet">
              {roleWord(role)}
            </Text>
          )}
        </div>
        <Text size="xs" tone="quiet">
          {`${expiresLine(i.expiresAt, now)}. Invited ${by}.`}
        </Text>
        {error === undefined ? null : (
          <p role="alert" className={s.alertLine}>
            <Text size="xs" tone="danger">{`Not revoked: ${error}`}</Text>
          </p>
        )}
      </div>
      <div className={a.controls}>
        <Button size="sm" variant="ghost" disabled={!live || busy} onClick={revoke}>
          Revoke
        </Button>
      </div>
    </div>
  );
}
