// Settings › Hub › Billing on a fleetd cloud team (a hub that came with the account), for its owners and admins: the
// plan and when it renews or ends, the credits left (and the soonest that lapse, within 30 days), the computer time used
// this period by size, and the team's own monthly spend cap. Change plan, Add credits and Manage payment open Stripe's
// checkout or portal in the browser (main: src/main/cloud/billing.ts); no card is ever typed here. A declined card, no
// credits or a reached cap is one line at the top with its fix (no credits: Pick a plan and Add credits right under it).
// Every price, included amount and rate is the service's answer (shared/billing.ts). A self-hosted hub has no Billing
// at all, and a team has none until fleetd's computers are on for it (`useBillingShown`): no entry, no search result,
// and a link to it lands on People.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import {
  billingOn,
  buys,
  capFromInput,
  capLine,
  capToInput,
  dayWord,
  expiringSoon,
  hours,
  money,
  noBuyWhy,
  periodWord,
  planLine,
  planWord,
  rateWord,
  sizeWord,
  topLine,
  usageRows,
  type BillingState,
} from "../../../shared/billing";
import type { BillingOpen } from "../../../shared/cloud";
import type { PairFailure } from "../../../shared/pairing";
import { Button, Input, Menu, MenuContent, MenuItem, MenuTrigger, Text, toast } from "../../ui";
import { useHub } from "../../src/data/react";
import { useNow } from "../live";
import { navigate } from "../shell/navigation";
import { GroupNote, HintLines, Notice, PageHead, SettingsRow, SettingsSection } from "../settings/parts";
import { useReveal } from "../settings/search";
import s from "../settings/settings.module.css";
import b from "./billing.module.css";

const said = (f: PairFailure): string => (f.fix === undefined ? f.message : `${f.message} ${f.fix}`);

export const billingKey = (hub: string) => ["cloud_billing", hub] as const;

/**
 * The team's billing, read on opening the page and again each time the app comes back to the front: a checkout or the
 * portal finishes in the browser, and the person returns here to see it.
 */
export function useBilling(enabled: boolean) {
  const hub = useHub().id;
  return useQuery({
    queryKey: billingKey(hub),
    enabled,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<BillingState> => {
      const out = await window.fleetd.cloud.billing(hub);
      if (!out.ok) throw new Error(said(out.failure));
      return out.billing;
    },
  });
}

/**
 * Whether the hub in scope has Billing: a fleetd cloud team whose answer says fleetd's computers are on for it. Read
 * only while `asked` (the Settings index, a Hub page's switch on Billing), sharing the page's own query.
 */
export function useBillingShown(asked = true): boolean {
  const cloud = useHub().cloud === true;
  const read = useBilling(asked && cloud);
  return cloud && billingOn(read.data);
}

/** Stripe's page for `what`, in the browser; a refusal is a toast in the team's words. */
function useOpen() {
  const hub = useHub().id;
  const [busy, setBusy] = useState<string | null>(null);
  const open = (what: BillingOpen, label: string) => {
    setBusy(label);
    void window.fleetd.cloud
      .billingOpen(hub, what)
      .then((out) => {
        if (!out.ok) toast({ title: out.failure.message, description: out.failure.fix, tone: "danger", key: "billing-open" });
      })
      .finally(() => setBusy(null));
  };
  return { busy, open };
}

export function Billing() {
  const hub = useHub();
  const read = useBilling(hub.cloud === true);
  const nowMs = useNow(true, 60_000);
  // No page that only says there is nothing here: a link to Billing where it isn't lands on People instead.
  const none = hub.cloud !== true || (read.data !== undefined && !billingOn(read.data));
  useEffect(() => {
    if (none) navigate({ id: "settings", tab: "hub.people", at: hub.id }, { replace: true });
  }, [none, hub.id]);
  if (none) return null;
  return (
    <div className={s.scroll} data-screen="settings.hub.billing">
      <div className={s.column}>
        <PageHead title="Billing" />
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
              {`Couldn't read billing: ${read.error.message}`}
            </GroupNote>
          </SettingsSection>
        ) : (
          <BillingBody state={read.data} nowMs={nowMs} />
        )}
      </div>
    </div>
  );
}

function BillingBody({ state, nowMs }: { state: BillingState; nowMs: number }) {
  const { busy, open } = useOpen();
  const capField = useRef<HTMLInputElement>(null);
  const top = topLine(state);
  const can = buys(state);
  const why = noBuyWhy(state);
  // The portal answers only once the team has paid for something: a plan, or credits it had.
  const paidBefore = state.plan !== null || state.credits.leftCents !== 0 || state.credits.expiring !== null || state.held === "empty";
  const portal = (label: string) => (
    <Button size="sm" disabled={busy !== null} onClick={() => open("portal", label)}>
      {busy === label ? "Opening…" : label}
    </Button>
  );
  const fix =
    top === null || !can
      ? undefined
      : top.fix === "portal"
        ? portal("Update card")
        : top.fix === "cap"
            ? (
                <Button size="sm" onClick={() => capField.current?.focus()}>
                  Raise cap
                </Button>
              )
            : undefined;
  const soon = expiringSoon(state, nowMs);
  const credits = money(state.credits.leftCents, state.currency);
  return (
    <>
      {top === null ? null : (
        <div className={b.top}>
          <Notice tone={top.tone} action={fix}>
            {top.message}
          </Notice>
        </div>
      )}
      <SettingsSection intro={why}>
        <SettingsRow
          reveal="hub.billing.plan"
          title="Plan"
          hint={<HintLines lines={state.plans.map((p) => [p.name, `${money(p.priceCents, state.currency)} a month, ${money(p.creditsCents, state.currency)} of computer time included`] as const)} />}
          line={[planWord(state), planLine(state, nowMs)].filter((w) => w !== null).join(" · ")}
          control={!can ? undefined : state.plan === null ? <Plans state={state} busy={busy} open={open} /> : portal("Change plan")}
          data={{ "data-plan": state.plan?.key ?? "none" }}
        />
        <SettingsRow
          reveal="hub.billing.credits"
          title="Credits"
          hint="Computer time paid ahead, in dollars. A plan's included time is used first and ends with its month; bought credits last a year."
          line={soon === null ? `${credits} left` : `${credits} left · ${money(soon.cents, state.currency)} expire ${dayWord(soon.at, nowMs)}`}
          control={can ? <TopUps state={state} busy={busy} open={open} label="Add credits" /> : undefined}
        />
        {can && paidBefore ? <SettingsRow title="Payment" hint="Card, invoices and VAT id, on Stripe's page." control={portal("Manage billing")} /> : null}
      </SettingsSection>
      <Usage state={state} nowMs={nowMs} />
      <Cap state={state} field={capField} can={state.canBuy} />
    </>
  );
}

/** Pick a plan: each the service offers, its price beside it; one opens Stripe's checkout for it. */
function Plans({ state, busy, open }: { state: BillingState; busy: string | null; open: (what: BillingOpen, label: string) => void }) {
  return (
    <Menu>
      <MenuTrigger asChild disabled={busy !== null}>
        <Button size="sm" variant="primary">
          {busy === "Pick a plan" ? "Opening…" : "Pick a plan"}
        </Button>
      </MenuTrigger>
      <MenuContent align="end">
        {state.plans.map((p) => (
          <MenuItem key={p.key} hint={`${money(p.priceCents, state.currency)} a month`} onSelect={() => open({ plan: p.key }, "Pick a plan")}>
            {p.name}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

/** Add credits: each top-up the service offers, at face value; one opens Stripe's checkout for it. */
function TopUps({ state, busy, open, label }: { state: BillingState; busy: string | null; open: (what: BillingOpen, label: string) => void; label: string }) {
  return (
    <Menu>
      <MenuTrigger asChild disabled={busy !== null}>
        <Button size="sm">{busy === label ? "Opening…" : label}</Button>
      </MenuTrigger>
      <MenuContent align="end">
        {state.topUps.map((t) => (
          <MenuItem key={t.key} onSelect={() => open({ topUp: t.key }, label)}>
            {money(t.creditsCents, state.currency)}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

/** Computer time this period, a row per size used: its hours and what they cost; the rates in the label's hint. */
function Usage({ state, nowMs }: { state: BillingState; nowMs: number }) {
  const rows = usageRows(state);
  const used = (seconds: number, cents: number) => (
    <Text tone="quiet" className={b.figure}>
      {`${hours(seconds)} · ${money(cents, state.currency)}`}
    </Text>
  );
  return (
    <SettingsSection
      title="Computer time"
      reveal="hub.billing.usage"
      hint={state.rates.length === 0 ? undefined : <HintLines lines={state.rates.map((r) => [sizeWord(r), rateWord(r.centsPerHour, state.currency)] as const)} />}
      aside={
        <Text size="sm" tone="quiet">
          {periodWord(state, nowMs)}
        </Text>
      }
    >
      {rows.length === 0 ? (
        <GroupNote>None used yet.</GroupNote>
      ) : (
        <>
          {rows.map((r) => (
            <SettingsRow key={`${String(r.cpu)}/${String(r.memGb)}`} title={sizeWord(r)} control={used(r.seconds, r.cents)} />
          ))}
          {rows.length > 1 ? <SettingsRow title="Total" control={used(state.usage.seconds, state.usage.cents)} /> : null}
        </>
      )}
    </SettingsSection>
  );
}

/** The team's monthly spend cap: a dollar amount, empty for none. Save shows once it differs from the team's. */
function Cap({ state, field, can }: { state: BillingState; field: RefObject<HTMLInputElement | null>; can: boolean }) {
  const hub = useHub().id;
  const client = useQueryClient();
  const ref = useReveal<HTMLDivElement>("hub.billing.cap");
  const id = useId();
  const kept = capToInput(state.credits.capCents);
  const [typed, setTyped] = useState(kept);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cents = capFromInput(typed);
  const changed = cents !== undefined && cents !== state.credits.capCents;
  const save = () => {
    if (cents === undefined) return;
    setBusy(true);
    setError(null);
    void window.fleetd.cloud
      .billingCap(hub, cents)
      .then(async (out) => {
        if (!out.ok) return setError(said(out.failure));
        setTyped(capToInput(out.capCents));
        await client.invalidateQueries({ queryKey: billingKey(hub) });
      })
      .finally(() => setBusy(false));
  };
  const line = error ?? (typed.trim() !== "" && cents === undefined ? "A dollar amount, like 50 or 12.50." : capLine(state));
  return (
    <div ref={ref}>
      <SettingsSection title="Spend cap">
        <SettingsRow
          title={<label htmlFor={id}>Monthly cap</label>}
          label="Monthly cap"
          hint="Bots on fleetd's computers stop when this month's spend reaches it, and start again next month or when it's raised. Empty: no cap."
          line={line ?? (can ? undefined : "Only the team's owners and admins set it.")}
          lineTone={error !== null || (typed.trim() !== "" && cents === undefined) ? "danger" : undefined}
          control={
            <div className={s.inline}>
              <span className={b.money}>
                <span className={b.unit} aria-hidden>
                  $
                </span>
                <Input
                  ref={field}
                  id={id}
                  className={b.capInput}
                  inputMode="decimal"
                  placeholder="None"
                  value={typed}
                  disabled={!can || busy}
                  onChange={(e) => {
                    setTyped(e.target.value);
                    setError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && changed) save();
                  }}
                />
              </span>
              {changed ? (
                <Button size="sm" variant="primary" disabled={busy} onClick={save}>
                  {busy ? "Saving…" : "Save"}
                </Button>
              ) : null}
            </div>
          }
        />
      </SettingsSection>
    </div>
  );
}
