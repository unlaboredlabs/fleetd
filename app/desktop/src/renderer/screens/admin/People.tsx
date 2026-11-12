// Settings › Hub › People: everyone on the hub, with their role, devices, and the Claude and GitHub their work runs on
// (claude_accounts_get and github_app_get answer an admin with everyone's), any usage pause on their account included. An owner or admin changes a role in place
// (person_set) or removes someone (person_remove, once confirmed: their devices are signed out at once). What a row
// offers comes from model.ts; the hub checks it all again. Invite someone is the plus beside the page's line
// (Invites.tsx); someone invited who hasn't joined is one row, with their invite's Revoke. Then every hub link minted here, which acts as its person (hubLinks/AllLinks.tsx). On a fleetd cloud team (a hub that
// came with the account) the plus invites by email instead, and who is invited so is listed under People
// (EmailInvites.tsx); a self-hosted hub's page is the one above, with nothing of the cloud on it.
import { Mail, User } from "lucide-react";
import { useState } from "react";
import type { HubRole, Invite, PeopleListOutput, Person } from "../../../shared/contracts";
import { lacksTool } from "../../src/data/errors";
import { CallError } from "../../src/data/queries";
import { Button, Dialog, Select, Text } from "../../ui";
import { errorText, useHubCall, useLive, useRefetch } from "../settings/hub";
import { AddButton, PageHead, SettingsList, SettingsListRow, SettingsSection } from "../settings/parts";
import { useReveal } from "../settings/search";
import { openUpdates } from "../updates/state";
import { AllLinks } from "../hubLinks/AllLinks";
import { invitedBy, InviteSection, OpenInvite } from "./Invites";
import { EmailInviteList, EmailInviteSection, useEmailInvites } from "./EmailInvites";
import { useHub, useToolQuery } from "../../src/data/react";
import { useNow } from "../live";
import { HubText } from "../projects/HubText";
import { pauseLine } from "../settings/claudeModel";
import { accountsLine, devicesLine, expiresLine, openInvites, peopleRows, roleWord, type PersonRow } from "./model";
import { usePeople } from "./usePeople";
import s from "../settings/settings.module.css";
import a from "./admin.module.css";

const noInput = {};

/** A hub from before people answers that it has no such tool: it needs updating, not a retry. */
const lacksPeople = (error: unknown): boolean => error instanceof CallError && lacksTool(error.error);

/** In place of People and its invites on a hub from before people; the other Hub pages still work there. */
export function NeedsUpdate() {
  return (
    <div className={s.stack}>
      <Text tone="quiet">This hub needs updating to manage people. The other Hub pages work as they are.</Text>
      <span>
        <Button onClick={() => openUpdates(true)}>Update the hub</Button>
      </span>
    </div>
  );
}

export function People({ me }: { me: Person | undefined }) {
  const live = useLive();
  const read = usePeople();
  const [inviting, setInviting] = useState(false);
  const inviteRef = useReveal<HTMLSpanElement>("hub.invite");
  const canInvite = live && !lacksPeople(read.error);
  // A cloud team's owners and admins invite by email; the team refuses anyone else, so nobody else is offered it.
  const byEmail = useHub().cloud === true && (me?.role === "owner" || me?.role === "admin");
  const emailInvites = useEmailInvites(live && byEmail, read.dataUpdatedAt);
  return (
    <div className={s.scroll} data-screen="settings.hub.people">
      <div className={s.column}>
        <PageHead
          title="People"
          aside={
            canInvite && !inviting ? (
              <span ref={inviteRef}>
                <AddButton label={byEmail ? "Invite by email" : "Invite someone"} onClick={() => setInviting(true)} />
              </span>
            ) : undefined
          }
        />
        {canInvite && inviting ? byEmail ? <EmailInviteSection /> : <InviteSection /> : null}
        {!live ? (
          <Text tone="quiet">Connect to a hub to see and change this.</Text>
        ) : lacksPeople(read.error) ? (
          <NeedsUpdate />
        ) : read.error ? (
          <Text tone="danger">{`Couldn't read the people: ${errorText(read.error)}`}</Text>
        ) : read.data === undefined ? (
          <Text tone="quiet">Loading…</Text>
        ) : (
          <PeopleList list={read.data} me={me} />
        )}
        {live && byEmail ? <EmailInviteList read={emailInvites} /> : null}
        <AllLinks />
      </div>
    </div>
  );
}

function PeopleList({ list, me }: { list: PeopleListOutput; me: Person | undefined }) {
  const [removing, setRemoving] = useState<PersonRow | null>(null);
  const rows = peopleRows(list, me);
  const live = useLive();
  const claude = useToolQuery("claude_accounts_get", noInput, { enabled: live });
  const github = useToolQuery("github_app_get", noInput, { enabled: live });
  const usage = useToolQuery("usage_status", noInput, { enabled: live });
  const nowMs = useNow(true, 60_000);
  const accounts = (personId: string) => {
    const line = accountsLine(
      claude.data?.people?.find((p) => p.person.personId === personId),
      github.data?.people?.find((p) => p.person.personId === personId),
      github.data?.app !== undefined,
    );
    const pause = pauseLine({ kind: "person", personId }, usage.data?.machines ?? [], nowMs);
    return { line, pause };
  };
  // Someone invited who hasn't joined is one row, their invite's in it; an invite for someone already here (one more
  // device) waits below.
  const open = openInvites(list.invites);
  const inviteOf = (row: PersonRow) => (row.invited ? open.find((i) => i.person.personId === row.person.personId) : undefined);
  const others = open.filter((i) => !rows.some((r) => r.invited && r.person.personId === i.person.personId));
  return (
    <>
      <SettingsSection reveal="hub.invites">
        <SettingsList label="People">
          {rows.map((row) => (
            <PersonLine
              key={row.person.personId}
              row={row}
              me={me}
              invite={inviteOf(row)}
              accounts={accounts(row.person.personId)}
              onRemove={() => setRemoving(row)}
            />
          ))}
        </SettingsList>
      </SettingsSection>
      {others.length === 0 ? null : (
        <SettingsSection title="Waiting to join" hint="Invites for one more device of someone already here.">
          <SettingsList label="Open invites">
            {others.map((i) => (
              <OpenInvite key={i.inviteId} invite={i} role={list.people.find((p) => p.personId === i.person.personId)?.role} me={me} />
            ))}
          </SettingsList>
        </SettingsSection>
      )}
      <RemoveDialog row={removing} onClose={() => setRemoving(null)} />
    </>
  );
}

function PersonLine({
  row,
  me,
  invite,
  accounts,
  onRemove,
}: {
  row: PersonRow;
  me: Person | undefined;
  invite: Invite | undefined;
  accounts: { line: string | null; pause: string | null };
  onRemove: () => void;
}) {
  const live = useLive();
  const call = useHubCall();
  const refetch = useRefetch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // Days-grained, so the time the page opened is close enough.
  const [now] = useState(() => Date.now());
  const p = row.person;
  const run = (tool: "person_set" | "invite_revoke", input: { personId: string; role: HubRole } | { inviteId: string }, failed: string) => {
    setBusy(true);
    setError(undefined);
    call(tool, input)
      .then(() => refetch(["people_list", "hub_info"]))
      .catch((e: unknown) => setError(`${failed}: ${errorText(e)}`))
      .finally(() => setBusy(false));
  };
  const setRole = (role: HubRole) => {
    if (role !== p.role) run("person_set", { personId: p.personId, role }, "Not changed");
  };
  const devices = row.devices.map((d) => d.name).join(", ");
  return (
    <SettingsListRow
      label={p.name}
      icon={row.invited ? <Mail /> : <User />}
      name={p.name}
      meta={row.you ? "you" : undefined}
      controls={
        <>
          {row.roles.length === 0 ? (
            <Text tone="quiet">{roleWord(p.role)}</Text>
          ) : (
            <Select
              aria-label={`${p.name}'s role`}
              className={a.role}
              value={p.role}
              options={row.roles.map((r) => ({ value: r, label: roleWord(r) }))}
              disabled={!live || busy}
              onValueChange={setRole}
            />
          )}
          {invite !== undefined && row.removable ? (
            <Button variant="ghost" disabled={!live || busy} onClick={() => run("invite_revoke", { inviteId: invite.inviteId }, "Not revoked")}>
              Revoke
            </Button>
          ) : row.removable ? (
            <Button variant="ghost" disabled={!live || busy} onClick={onRemove}>
              Remove
            </Button>
          ) : null}
        </>
      }
    >
      <Text size="sm" tone="quiet">
        {invite !== undefined
          ? `Invited ${invitedBy(invite, me)}. ${expiresLine(invite.expiresAt, now)}.`
          : row.invited
            ? "Invited, not joined yet"
            : devices === ""
              ? devicesLine(0)
              : `${devicesLine(row.devices.length)}: ${devices}`}
      </Text>
      {accounts.line === null || row.invited ? null : (
        <Text size="sm" tone="quiet" data-accounts>
          {accounts.line}
        </Text>
      )}
      {accounts.pause === null ? null : (
        <Text size="sm" tone="warning">
          <HubText>{accounts.pause}</HubText>
        </Text>
      )}
      {row.why ? (
        <Text size="sm" tone="quiet">
          {row.why}
        </Text>
      ) : null}
      {error === undefined ? null : (
        <p role="alert" className={s.alertLine}>
          <Text size="sm" tone="danger">
            {error}
          </Text>
        </p>
      )}
    </SettingsListRow>
  );
}

/** Asks before removing someone: their devices are signed out at once, and what they did keeps their name. */
function RemoveDialog({ row, onClose }: { row: PersonRow | null; onClose: () => void }) {
  const call = useHubCall();
  const refetch = useRefetch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const name = row?.person.name ?? "";
  const n = row?.devices.length ?? 0;
  const close = () => {
    setError(undefined);
    onClose();
  };
  const remove = () => {
    if (row === null) return;
    setBusy(true);
    setError(undefined);
    call("person_remove", { personId: row.person.personId })
      .then(() => {
        refetch(["people_list", "hub_info"]);
        close();
      })
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(false));
  };
  return (
    <Dialog
      open={row !== null}
      onOpenChange={(open) => !open && close()}
      title={`Remove ${name}?`}
      description={`${n === 0 ? "They have no device yet, and their open invites close." : `Their ${devicesLine(n).toLowerCase()} ${n === 1 ? "is" : "are"} signed out at once.`} What they did and the projects they made stay.`}
      footer={
        <>
          {error === undefined ? null : (
            <p role="alert" className={s.alertLine}>
              <Text size="xs" tone="danger">
                {error}
              </Text>
            </p>
          )}
          <Button onClick={close}>Cancel</Button>
          <Button variant="danger" disabled={busy} onClick={remove}>
            {`Remove ${name}`}
          </Button>
        </>
      }
    />
  );
}
