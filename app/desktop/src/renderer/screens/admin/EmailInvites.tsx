// Settings › Hub › People on a fleetd cloud team (a hub that came with the account): an owner or admin invites by email,
// and fleetd cloud has the email sent (main: src/main/cloud/invites.ts, contracts: Accounts.json); the person joins by
// signing in with that address. Who is invited and hasn't joined is a list under People, each with Revoke. A refusal
// (not an email, someone already here or invited, the team at its limit) is one line by the field, in the team's words.
// A self-hosted hub never shows any of this: its People keeps the invite link (Invites.tsx).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { InviteRequest } from "../../../shared/cloud";
import type { AccountsInvite } from "../../../shared/contracts";
import type { PairFailure } from "../../../shared/pairing";
import { Button, Input, Radio, RadioGroup, Text } from "../../ui";
import { useHub, useSeveralHubs } from "../../src/data/react";
import { useLive } from "../settings/hub";
import { HintLines, SettingsList, SettingsListRow, SettingsRow, SettingsSection } from "../settings/parts";
import { useReveal } from "../settings/search";
import { expiresLine, ROLE_HELP, roleWord } from "./model";
import s from "../settings/settings.module.css";
import a from "./admin.module.css";

/** The roles an invite by email offers; owners are made from People, by an owner. */
const ROLES: ReadonlyArray<InviteRequest["role"]> = ["member", "admin"];

const said = (f: PairFailure): string => (f.fix === undefined ? f.message : `${f.message} ${f.fix}`);

const key = (hub: string) => ["cloud_invites", hub] as const;

/**
 * The team's open invites by email, newest first. No hub event names them, so they are read again with the people
 * (`peopleReadAt`, people_list's read time, which people.changed renews): someone joining leaves the list at once, as
 * does an invite another admin made or revoked. Opening the page reads them afresh too.
 */
export function useEmailInvites(enabled: boolean, peopleReadAt: number) {
  const hub = useHub().id;
  const client = useQueryClient();
  // The people's first read comes with the page's own read of the invites; only a read after it asks again.
  const seen = useRef(peopleReadAt);
  useEffect(() => {
    const first = seen.current === 0;
    seen.current = peopleReadAt;
    if (enabled && !first && peopleReadAt > 0) void client.invalidateQueries({ queryKey: key(hub) });
  }, [client, hub, enabled, peopleReadAt]);
  return useQuery({
    queryKey: key(hub),
    enabled,
    retry: false,
    staleTime: 0,
    queryFn: async (): Promise<ReadonlyArray<AccountsInvite>> => {
      const out = await window.fleetd.cloud.invites(hub);
      if (!out.ok) throw new Error(said(out.failure));
      return out.invites;
    },
  });
}

/** Invite by email, opened by People's plus. */
export function EmailInviteSection() {
  const ref = useReveal<HTMLDivElement>("hub.invite");
  return (
    <div ref={ref}>
      <SettingsSection title="Invite by email" hint="fleetd emails them an invite. They join by signing in with that address; it works for 7 days.">
        <EmailInviteForm />
      </SettingsSection>
    </div>
  );
}

function EmailInviteForm() {
  const hub = useHub();
  const several = useSeveralHubs();
  const client = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InviteRequest["role"]>("member");
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<{ text: string; refused: boolean } | null>(null);
  const emailId = useId();
  const send = () => {
    const typed = email.trim();
    if (typed === "") {
      setLine({ text: "Type the person's email.", refused: true });
      return;
    }
    setBusy(true);
    setLine(null);
    void window.fleetd.cloud
      .invite(hub.id, { email: typed, role })
      .then((out) => {
        if (!out.ok) {
          setLine({ text: said(out.failure), refused: true });
          return;
        }
        setEmail("");
        setLine({ text: `Invite sent to ${out.invite.email}. They get an email, and join by signing in with it.`, refused: false });
        void client.invalidateQueries({ queryKey: key(hub.id) });
      })
      .catch(() => setLine({ text: "This app couldn't send that. Check the address, then try again.", refused: true }))
      .finally(() => setBusy(false));
  };
  return (
    <form
      aria-label="Invite by email"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <SettingsRow
        title={<label htmlFor={emailId}>Email</label>}
        label="Email"
        line={line === null ? undefined : <span role={line.refused ? "alert" : "status"}>{line.text}</span>}
        lineTone={line?.refused === true ? "danger" : "quiet"}
        control={
          <span className={a.emailInvite}>
            <Input
              id={emailId}
              type="email"
              className={a.inviteName}
              value={email}
              placeholder="alex@example.com"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                setEmail(e.target.value);
                if (line?.refused === true) setLine(null);
              }}
            />
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? "Inviting…" : several ? `Invite to ${hub.label}` : "Invite"}
            </Button>
          </span>
        }
      />
      <SettingsRow title="Role" titleId="email-invite-role" hint={<HintLines lines={ROLES.map((r) => [roleWord(r), ROLE_HELP[r]] as const)} />}>
        <RadioGroup value={role} onValueChange={(v) => setRole(v === "admin" ? "admin" : "member")} aria-labelledby="email-invite-role">
          {ROLES.map((r) => (
            <Radio key={r} value={r} label={roleWord(r)} />
          ))}
        </RadioGroup>
      </SettingsRow>
    </form>
  );
}

/** Who is invited by email and hasn't joined, each with Revoke; nothing when nobody is. */
export function EmailInviteList({ read }: { read: ReturnType<typeof useEmailInvites> }) {
  if (read.error !== null) {
    return (
      <p role="alert" className={s.alertLine}>
        <Text size="sm" tone="danger">{`Couldn't read the invites by email: ${read.error.message}`}</Text>
      </p>
    );
  }
  const list = read.data ?? [];
  if (list.length === 0) return null;
  return (
    <SettingsSection title="Invited by email" hint="They join when they sign in with that email.">
      <SettingsList label="Invited by email">
        {list.map((i) => (
          <EmailInviteRow key={i.inviteId} invite={i} />
        ))}
      </SettingsList>
    </SettingsSection>
  );
}

function EmailInviteRow({ invite: i }: { invite: AccountsInvite }) {
  const live = useLive();
  const hub = useHub().id;
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // Days-grained, so the time the page opened is close enough.
  const [now] = useState(() => Date.now());
  const revoke = () => {
    setBusy(true);
    setError(undefined);
    void window.fleetd.cloud
      .revokeInvite(hub, i.inviteId)
      .then((out) => {
        if (!out.ok) setError(`Not revoked: ${said(out.failure)}`);
      })
      .catch(() => setError("Not revoked: this app couldn't ask the team. Try again."))
      .finally(() => {
        setBusy(false);
        // Either way the list is read again: a refused revoke is mostly an invite used or gone meanwhile.
        void client.invalidateQueries({ queryKey: key(hub) });
      });
  };
  return (
    <SettingsListRow
      label={i.email}
      icon={<Mail />}
      name={i.email}
      meta={roleWord(i.role)}
      controls={
        <Button variant="ghost" disabled={!live || busy} onClick={revoke}>
          Revoke
        </Button>
      }
    >
      <Text size="sm" tone="quiet">
        {`${expiresLine(i.expiresAt, now)}.`}
      </Text>
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
