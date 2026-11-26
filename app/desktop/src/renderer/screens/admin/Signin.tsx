// Settings › Workspace › Sign-in on a fleetd cloud workspace, for its owners and admins (the workspace refuses anyone
// else): the one sign-in method its admins and members must use, from each person's next sign-in, and that owners
// are let in however they sign in; its email
// domains, each added and verified on WorkOS's domain verification page, which the workspace's answer opens in the
// browser (main: src/main/cloud/signin.ts); and whether people of its verified domains join by themselves. A
// self-hosted workspace has no such page: its sign-in is its own.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { PairFailure } from "../../../shared/pairing";
import {
  atDomains,
  BREAK_GLASS,
  domainWord,
  REQUIRE_CHOICES,
  requireChoice,
  requireLine,
  requireOf,
  verifiedDomains,
  type SigninChange,
  type SigninState,
} from "../../../shared/signin";
import { Button, Select, toast } from "../../ui";
import { useHub } from "../../src/data/react";
import { navigate } from "../shell/navigation";
import { GroupNote, PageHead, SettingsRow, SettingsSection, SwitchRow } from "../settings/parts";
import s from "../settings/settings.module.css";

const said = (f: PairFailure): string => (f.fix === undefined ? f.message : `${f.message} ${f.fix}`);

export const signinKey = (hub: string) => ["cloud_signin", hub] as const;

/** The workspace's sign-in, read on opening the page and on coming back to it: a domain is verified in the browser. */
function useSignin(enabled: boolean) {
  const hub = useHub().id;
  return useQuery({
    queryKey: signinKey(hub),
    enabled,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<SigninState> => {
      const out = await window.fleetd.cloud.signin(hub);
      if (!out.ok) throw new Error(said(out.failure));
      return out.signin;
    },
  });
}

export function SigninPage() {
  const hub = useHub();
  const read = useSignin(hub.cloud === true);
  // A link here on a self-hosted workspace lands on People: there is nothing of the cloud's to set.
  useEffect(() => {
    if (hub.cloud !== true) navigate({ id: "settings", tab: "hub.people", at: hub.id }, { replace: true });
  }, [hub.cloud, hub.id]);
  if (hub.cloud !== true) return null;
  return (
    <div className={s.scroll} data-screen="settings.hub.signin">
      <div className={s.column}>
        <PageHead title="Sign-in" />
        {read.isPending ? (
          <SettingsSection>
            <GroupNote>Loading…</GroupNote>
          </SettingsSection>
        ) : read.isError ? (
          <SettingsSection>
            <GroupNote
              tone="danger"
              action={
                <Button size="sm" onClick={() => void read.refetch()}>
                  Try again
                </Button>
              }
            >
              {`Couldn't read the workspace's sign-in: ${read.error.message}`}
            </GroupNote>
          </SettingsSection>
        ) : (
          <SigninBody state={read.data} />
        )}
      </div>
    </div>
  );
}

/** The page that adds and verifies a domain, asked for on each press (its address lasts minutes); a refusal is a toast. */
function useDomainPage() {
  const hub = useHub().id;
  const [busy, setBusy] = useState(false);
  const open = () => {
    setBusy(true);
    void window.fleetd.cloud
      .signinDomain(hub)
      .then((out) => {
        if (!out.ok) toast({ title: out.failure.message, description: out.failure.fix, tone: "danger", key: "signin-domain" });
      })
      .finally(() => setBusy(false));
  };
  return { busy, open };
}

/** A change to the method or the domain switch; the answer is the whole state as kept, put in place of the read. */
function useChange() {
  const hub = useHub().id;
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = (what: SigninChange) => {
    setBusy(true);
    setError(null);
    void window.fleetd.cloud
      .signinSet(hub, what)
      .then((out) => {
        if (!out.ok) return setError(said(out.failure));
        client.setQueryData(signinKey(hub), out.signin);
      })
      .finally(() => setBusy(false));
  };
  return { busy, error, change };
}

function SigninBody({ state }: { state: SigninState }) {
  const domainPage = useDomainPage();
  const { busy, error, change } = useChange();
  const verified = verifiedDomains(state);
  const addButton = (label: string) => (
    <Button size="sm" disabled={domainPage.busy} onClick={domainPage.open}>
      {domainPage.busy ? "Opening…" : label}
    </Button>
  );
  return (
    <>
      <SettingsSection>
        <SettingsRow
          title="Sign-in method"
          hint={requireLine(state.require)}
          control={
            <Select
              aria-label="Sign-in method"
              value={requireChoice(state.require)}
              options={REQUIRE_CHOICES}
              disabled={busy}
              onValueChange={(v) => {
                const next = requireOf(v);
                if (next !== state.require) change({ require: next });
              }}
            />
          }
          data={{ "data-require": state.require ?? "any" }}
        />
        {error === null ? null : <GroupNote tone="danger">{error}</GroupNote>}
        <GroupNote>{BREAK_GLASS}</GroupNote>
      </SettingsSection>
      <SettingsSection
        title="Email domains"
        hint="Each one is verified with a DNS record, so only the company that owns a domain can claim it."
        aside={state.domains.length === 0 ? undefined : addButton("Manage domains")}
      >
        {state.domains.length === 0 ? (
          <SettingsRow title="Email domain" line="None yet" control={addButton("Add domain")} data={{ "data-domain": "none" }} />
        ) : (
          state.domains.map((d) => (
            <SettingsRow
              key={d.domain}
              title={d.domain}
              line={domainWord(d)}
              lineTone={d.state === "verified" ? "success" : d.state === "failed" ? "danger" : undefined}
              data={{ "data-domain": d.state }}
            />
          ))
        )}
        <SwitchRow
          title={verified.length === 0 ? "Join by email domain" : `People with ${atDomains(verified)} join automatically`}
          hint="They join as members the first time they sign in, with no invite. Off: only people invited join."
          line={verified.length === 0 ? "Needs a verified email domain." : undefined}
          checked={state.domainJoin}
          disabled={busy || (verified.length === 0 && !state.domainJoin)}
          onCheckedChange={(on) => change({ domainJoin: on })}
          data={{ "data-domain-join": String(state.domainJoin) }}
        />
      </SettingsSection>
    </>
  );
}
