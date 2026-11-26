// Settings › Hub › Billing on a fleetd cloud team (a hub that came with the account), for its owners and admins: the
// plan and when it renews or ends, the credits left (and the soonest that lapse, within 30 days), the computer time used
// this period by size, the team's own monthly spend cap and its warnings (on by default: at 50, 80 and 100% of the cap
// and when credits run low), and the spend limits set for a person or a bot (Limits.tsx). Change plan, Add credits and Manage payment open Stripe's
// checkout or portal in the browser (main: src/main/cloud/billing.ts); no card is ever typed here. A declined card, no
// credits, a reached cap or a spend warning is one line at the top with its fix (no credits: Pick a plan and Add credits right under it).
// Every price, included amount and rate is the service's answer (shared/billing.ts). A self-hosted hub has no Billing
// at all, and a team has none until fleetd's computers are on for it (`useBillingShown`): no entry, no search result,
// and a link to it lands on People.
import { useQueryClient } from "@tanstack/react-query";
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
  planChoice,
  planLine,
  planTerms,
  planWord,
  rateWord,
  sizeWord,
  topLine,
  usageRows,
  percentsWord,
  warningsWhen,
  type BillingState,
  billingReturnOf,
  PAID_READ_EVERY_MS,
  PAID_WAIT_MS,
  paidLine,
  portalShown,
  showsPaid,
  withoutBillingReturn,
} from "../../../shared/billing";
import type { BillingOpen } from "../../../shared/cloud";
import type { PairFailure } from "../../../shared/pairing";
import { Button, Input, Menu, MenuContent, MenuItem, MenuTrigger, Text, toast } from "../../ui";
import { useHub } from "../../src/data/react";
import { billingKey, useBilling } from "./billingQuery";
import { useNow } from "../live";
import { navigate } from "../shell/navigation";
import { GroupNote, HintLines, Notice, PageHead, SettingsRow, SettingsSection, SwitchRow } from "../settings/parts";
import { LimitsSection } from "./Limits";
import { useReveal } from "../settings/search";
import s from "../settings/settings.module.css";
import b from "./billing.module.css";

const said = (f: PairFailure): string => (f.fix === undefined ? f.message : `${f.message} ${f.fix}`);

type BillingReturn = { readonly said: "paid" | "cancelled"; readonly atMs: number; readonly hub: string };

let returned: BillingReturn | null | undefined;

/**
 * What Stripe's way back said (`?billing=paid` or `cancelled` on the web app's address), for `hub`: read from the
 * address once per page load and cleaned from it at once, so a reload doesn't say it again. It belongs to the team the
 * app opened on coming back (the address's `team=`, teamFromAddress), so another team's Billing never says it, and it is
 * said once: `endBillingReturn` drops it once shown. Only the web app comes back this way.
 */
const takeBillingReturn = (hub: string): BillingReturn | null => {
  if (returned === undefined) {
    const said = billingReturnOf(window.location.search);
    if (said !== null) {
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${withoutBillingReturn(window.location.search)}${window.location.hash}`);
    }
    returned = said === null ? null : { said, atMs: Date.now(), hub };
  }
  return returned !== null && returned.hub === hub ? returned : null;
};

const endBillingReturn = (back: BillingReturn): void => {
  if (returned === back) returned = null;
};

/** For tests: read the address again. */
export const resetBillingReturn = (): void => {
  returned = undefined;
};

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
  const [taken] = useState(() => takeBillingReturn(hub.id));
  // Kept for this visit only (the line waits on Stripe here), and only while the page is on the team that paid.
  const back = taken !== null && taken.hub === hub.id ? taken : null;
  // Back from paying: read again until Stripe's word of it shows, for a minute at most.
  const waiting = back?.said === "paid" && (read.data === undefined || !showsPaid(read.data));
  const nowMs = useNow(true, waiting ? PAID_READ_EVERY_MS : 60_000);
  const { refetch } = read;
  useEffect(() => {
    if (back === null) return;
    toast({ title: back.said === "paid" ? "Payment received" : "Checkout cancelled: nothing was charged", tone: back.said === "paid" ? "success" : "neutral", key: "billing-return" });
    endBillingReturn(back);
  }, [back]);
  useEffect(() => {
    if (waiting && nowMs - back.atMs < PAID_WAIT_MS) void refetch();
  }, [waiting, back, nowMs, refetch]);
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
          <BillingBody state={read.data} nowMs={nowMs} paid={paidLine(back?.said ?? null, read.data, nowMs - (back?.atMs ?? nowMs))} />
        )}
      </div>
    </div>
  );
}

function BillingBody({ state, nowMs, paid }: { state: BillingState; nowMs: number; paid: string | null }) {
  const { busy, open } = useOpen();
  const capField = useRef<HTMLInputElement>(null);
  // Just back from paying, Stripe's word on its way: that, not "no credits".
  const top = paid !== null ? { tone: "warning" as const, message: paid, fix: null } : topLine(state);
  const can = buys(state);
  const why = noBuyWhy(state);
  // The portal answers only once the team has paid for something: a plan, or credits it had.
  const paidBefore = portalShown(state);
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
          hint={<HintLines lines={state.plans.map((p) => [p.name, planTerms(p, state.currency)] as const)} />}
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
      <LimitsSection state={state} />
    </>
  );
}

/** Pick a plan: each the service offers, its price and agents at once beside it; one opens Stripe's checkout for it. */
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
          <MenuItem key={p.key} hint={planChoice(p, state.currency)} onSelect={() => open({ plan: p.key }, "Pick a plan")}>
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
          line={line ?? (can ? undefined : "Only the workspace's owners and admins set it.")}
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
        <Warnings state={state} can={can} />
      </SettingsSection>
    </div>
  );
}

/** The spend warnings' switch: on unless an admin turned it off; a cloud before them shows none. */
function Warnings({ state, can }: { state: BillingState; can: boolean }) {
  const hub = useHub().id;
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const w = state.warnings;
  if (w === null) return null;
  const set = (on: boolean) => {
    setBusy(true);
    setError(null);
    void window.fleetd.cloud
      .billingWarnings(hub, on)
      .then(async (out) => {
        if (!out.ok) return setError(said(out.failure));
        await client.invalidateQueries({ queryKey: billingKey(hub) });
      })
      .finally(() => setBusy(false));
  };
  return (
    <SwitchRow
      reveal="hub.billing.warnings"
      title="Spend warnings"
      hint="An email to the workspace's owners and admins, and a line in each bot's chat on fleetd's computers. Each goes once a month."
      line={
        error ??
        (!w.on
          ? "Off: nobody is told before the cap stops the bots."
          : state.credits.capCents === null
            ? w.lowCredits
              ? `When credits run low. Set a cap to be warned at ${percentsWord(w)} of it too.`
              : `Set a cap to be warned at ${percentsWord(w)} of it.`
            : warningsWhen(w))
      }
      lineTone={error === null ? undefined : "danger"}
      checked={w.on}
      disabled={!can || busy}
      onCheckedChange={set}
      data={{ "data-warnings": String(w.on) }}
    />
  );
}
