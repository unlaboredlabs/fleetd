// Spend limits on a fleetd cloud workspace (shared/billing.ts's `limits`, from the same `GET /billing/v1` the Billing
// page reads): each person's and each bot's own monthly limit on fleetd's computers, and this month's spend against
// it. Reaching one stops only that person's or bot's work there; the rest of the workspace carries on. An owner or
// admin sets a person's from their row on People (a dialog) and a bot's in its settings (a row); Billing lists every
// limit set. A member sees their own limit and spend alone, in Workspaces & devices, and no one else's.
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { capFromInput, capToInput, limitLine, limitsSet, type BillingLimits, type BillingState, type LimitOf, type SpendLimit } from "../../../shared/billing";
import type { PairFailure } from "../../../shared/pairing";
import { Button, Dialog, Input, Text } from "../../ui";
import { useHub } from "../../src/data/react";
import { navigate } from "../shell/navigation";
import { formatRoute } from "../settings/route";
import { GroupNote, SettingsList, SettingsListRow, SettingsRow, SettingsSection, useProjects } from "../settings/parts";
import { RUNNER_ID } from "../../../shared/providers";
import { useReveal } from "../settings/search";
import { billingKey, useBilling } from "./billingQuery";
import s from "../settings/settings.module.css";
import b from "./billing.module.css";

const said = (f: PairFailure): string => (f.fix === undefined ? f.message : `${f.message} ${f.fix}`);

/** What a person who reached their limit reads. */
export const STOPPED_PERSON = "Their work on fleetd's computers is stopped until next month, or until the limit is raised.";
const STOPPED_BOT = "Its work on fleetd's computers is stopped until next month, or until the limit is raised.";
const LIMIT_HINT = "This month's spend on fleetd's computers. Reaching the limit stops only this work; the rest of the workspace carries on. Empty: no limit.";

/** The workspace's billing where it has limits (a cloud workspace on fleetd's computers), else undefined. */
export function useLimits(enabled = true): { state: BillingState; limits: BillingLimits } | undefined {
  const cloud = useHub().cloud === true;
  const read = useBilling(enabled && cloud);
  const state = read.data;
  return state?.providedOn === true && state.limits !== null ? { state, limits: state.limits } : undefined;
}

/** Sets `of`'s limit; Billing's read is asked again after, so every page shows the limit kept. */
function useSetLimit(of: LimitOf) {
  const hub = useHub().id;
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = async (cents: number | null): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const out = await window.fleetd.cloud.billingLimit(hub, of, cents);
      if (!out.ok) {
        setError(said(out.failure));
        return false;
      }
      await client.invalidateQueries({ queryKey: billingKey(hub) });
      return true;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, set };
}

/** A dollar field with its sign before it, as the cap's: the typed text, and Enter to save. */
function MoneyField(props: { id: string; value: string; onChange: (v: string) => void; onEnter: () => void; disabled: boolean; label?: string }) {
  return (
    <span className={b.money}>
      <span className={b.unit} aria-hidden>
        $
      </span>
      <Input
        id={props.id}
        aria-label={props.label}
        className={b.capInput}
        inputMode="decimal"
        placeholder="None"
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") props.onEnter();
        }}
      />
    </span>
  );
}

/** A bot's spend limit, in its settings: an owner's or admin's, on a bot on fleetd's computers; nothing otherwise. */
export function BotLimitSetting({ projectId, administers }: { projectId: string; administers: boolean }) {
  const got = useLimits(administers);
  const row = got?.limits.bots.find((r) => r.projectId === projectId);
  if (!administers || got === undefined || row === undefined) return null;
  return <BotLimitRow row={row} currency={got.state.currency} />;
}

function BotLimitRow({ row, currency }: { row: SpendLimit & { projectId: string }; currency: string }) {
  const id = useId();
  const ref = useReveal<HTMLDivElement>("projects.limit");
  const { busy, error, setError, set } = useSetLimit({ projectId: row.projectId });
  const kept = capToInput(row.limitCents);
  const [typed, setTyped] = useState(kept);
  const cents = capFromInput(typed);
  const changed = cents !== undefined && cents !== row.limitCents;
  const bad = typed.trim() !== "" && cents === undefined;
  const save = () => {
    if (changed) void set(cents);
  };
  return (
    <div ref={ref}>
      <SettingsRow
        title={<label htmlFor={id}>Spend limit</label>}
        label="Spend limit"
        hint={LIMIT_HINT}
        line={error ?? (bad ? "A dollar amount, like 50 or 12.50." : row.stopped ? `${limitLine(row, currency)}. ${STOPPED_BOT}` : limitLine(row, currency))}
        lineTone={error !== null || bad ? "danger" : row.stopped ? "warning" : undefined}
        control={
          <div className={s.inline}>
            <MoneyField
              id={id}
              value={typed}
              disabled={busy}
              onChange={(v) => {
                setTyped(v);
                setError(null);
              }}
              onEnter={save}
            />
            {changed ? (
              <Button size="sm" variant="primary" disabled={busy} onClick={save}>
                {busy ? "Saving…" : "Save"}
              </Button>
            ) : null}
          </div>
        }
        data={{ "data-limit": row.limitCents === null ? "none" : String(row.limitCents), "data-stopped": String(row.stopped) }}
      />
    </div>
  );
}

/** A person's spend limit, from their row on People: the field, Save, and Remove limit while one is set. */
export function PersonLimitDialog({ row, currency, onClose }: { row: (SpendLimit & { personId: string }) | null; currency: string; onClose: () => void }) {
  return row === null ? null : <PersonLimitForm key={row.personId} row={row} currency={currency} onClose={onClose} />;
}

function PersonLimitForm({ row, currency, onClose }: { row: SpendLimit & { personId: string }; currency: string; onClose: () => void }) {
  const id = useId();
  const { busy, error, setError, set } = useSetLimit({ personId: row.personId });
  const [typed, setTyped] = useState(capToInput(row.limitCents));
  const cents = capFromInput(typed);
  const bad = typed.trim() !== "" && cents === undefined;
  const save = (to: number | null | undefined) => {
    if (to === undefined) return;
    void set(to).then((ok) => ok && onClose());
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`${row.name}'s spend limit`}
      description={`A monthly limit on fleetd's computers for the work ${row.name} starts. Reaching it stops only their work; the rest of the workspace carries on.`}
      footer={
        <>
          {error === null && !bad ? null : (
            <p role="alert" className={s.alertLine}>
              <Text size="xs" tone="danger">
                {error ?? "A dollar amount, like 50 or 12.50."}
              </Text>
            </p>
          )}
          {row.limitCents === null ? null : (
            <Button variant="ghost" disabled={busy} onClick={() => save(null)}>
              Remove limit
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || cents === undefined || cents === row.limitCents} onClick={() => save(cents)}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className={s.inline}>
        <MoneyField
          id={id}
          label="Monthly limit"
          value={typed}
          disabled={busy}
          onChange={(v) => {
            setTyped(v);
            setError(null);
          }}
          onEnter={() => cents !== row.limitCents && save(cents)}
        />
        <Text size="sm" tone="quiet">
          {`a month · spent ${limitLine({ ...row, limitCents: null }, currency)}`}
        </Text>
      </div>
    </Dialog>
  );
}

/**
 * Billing's list of the limits set: each person's and bot's, this month's spend against it, opening where it is set
 * (People, the bot's settings). None set: where to set one.
 */
export function LimitsSection({ state }: { state: BillingState }) {
  const hub = useHub().id;
  const projects = useProjects();
  if (state.limits === null) return null;
  // A bot's settings by its key: the machine the app has it on, else fleetd's computers' runner.
  const botKey = (projectId: string): string => `${projects?.find((p) => p.projectId === projectId)?.machineId ?? RUNNER_ID}/${projectId}`;
  const { members, bots } = limitsSet(state.limits);
  const row = (key: string, name: string, l: SpendLimit, go: () => void) => (
    <SettingsListRow
      key={key}
      name={name}
      label={name}
      state={l.stopped ? { word: "Stopped", tone: "warning" } : undefined}
      open={{ onClick: go }}
      data={{ "data-limit-row": key }}
    >
      <Text size="sm" tone="quiet" className={b.figure}>
        {limitLine(l, state.currency)}
      </Text>
    </SettingsListRow>
  );
  return (
    <SettingsSection title="Spend limits" reveal="hub.billing.limits" hint="A monthly limit for one person's work or one bot on fleetd's computers. Reaching it stops only that work.">
      {members.length + bots.length === 0 ? (
        <GroupNote>None set. Set one for a person on People, or for a bot in its settings.</GroupNote>
      ) : (
        <SettingsList label="Spend limits">
          {members.map((m) => row(`person:${m.personId}`, m.name, m, () => navigate({ id: "settings", tab: "hub.people", at: hub })))}
          {bots.map((bot) => row(`bot:${bot.projectId}`, bot.name, bot, () => (window.location.hash = formatRoute({ tab: "projects", for: botKey(bot.projectId) }))))}
        </SettingsList>
      )}
    </SettingsSection>
  );
}


/** The signed-in person's own limit on a cloud workspace, for Workspaces & devices; null while they have none. */
export function MyLimitLine({ personId }: { personId: string | undefined }) {
  const got = useLimits(personId !== undefined);
  const mine = got?.limits.members.find((m) => m.personId === personId);
  if (got === undefined || mine === undefined || mine.limitCents === null) return null;
  return (
    <Text size="sm" tone={mine.stopped ? "warning" : "quiet"} data-my-limit={String(mine.limitCents)}>
      {mine.stopped
        ? `You reached your spend limit: ${limitLine(mine, got.state.currency)}. Your work on fleetd's computers is stopped until next month, or until an admin raises it.`
        : `Your spend limit: ${limitLine(mine, got.state.currency)}.`}
    </Text>
  );
}
