import { useEffect, useState, type ReactNode } from "react";
import { Button, Dialog, Dot, InlineCode, Radio, RadioGroup, Select, Separator, Text, THEME_MODES, Truncate, textClass, useTheme } from "../../ui";
import type { LinkHandlerStatus } from "../../../shared/app";
import type { HubState } from "../../../shared/hub";
import { useData } from "../../src/data/react";
import { errorText, useHubCall, useLive, useRead, useRefetch } from "./hub";
import { MOTION_PREFS, parseMotion, setMotion, useMotion } from "./prefs";
import s from "./settings.module.css";
import { keyStoreLine } from "../../../shared/pairing";
import { useKeyStore } from "../onboarding";
import { sentence } from "../onboarding/form";
import { Prose } from "../onboarding/Prose";

const RETENTION = [7, 30, 90, 365] as const;

export function General() {
  const { mode, setMode } = useTheme();
  const motion = useMotion();
  return (
    <div className={s.scroll} data-screen="settings.general">
      <div className={s.column}>
        <Setting label="Appearance" help="Match system follows the OS as it changes.">
          <RadioGroup className={s.radios} value={mode} onValueChange={(v) => {
              const m = THEME_MODES.find((x) => x.value === v);
              if (m) setMode(m.value);
            }} aria-label="Appearance">
            {THEME_MODES.map((m) => (
              <Radio key={m.value} value={m.value} label={m.label} />
            ))}
          </RadioGroup>
        </Setting>
        <Setting label="Motion" help="Cards, lanes and panels move briefly when they change. Reduced turns that off; Match system follows the OS's reduce motion setting.">
          <RadioGroup className={s.radios} value={motion} onValueChange={(v) => setMotion(parseMotion(v))} aria-label="Motion">
            {MOTION_PREFS.map((m) => (
              <Radio key={m.value} value={m.value} label={m.label} />
            ))}
          </RadioGroup>
        </Setting>
        <Separator />
        <HubSetting />
        <LinkHandlerSetting />
        <Separator />
        <RetentionSetting />
        <Separator />
        <Setting
          label="Claude auto memory"
          help="Claude's own notes, kept per folder between sessions. Read-only here: a project's repository decides."
        >
          <div className={s.stack}>
            <Text>Off for every agent fleetd starts, unless a project turns it back on.</Text>
            <Text tone="quiet">
              Agents learn from their brief, your decisions and your instructions, never from notes another agent left in a worktree. To turn it on
              for one project, add <InlineCode>claude: {"{ autoMemory: true }"}</InlineCode> to <InlineCode>.fleetd/policy.yaml</InlineCode> in its
              repository and commit it; new sessions pick it up. <InlineCode>fleetd doctor</InlineCode> warns if a machine's claude keeps it on
              anyway.
            </Text>
          </div>
        </Setting>
      </div>
    </div>
  );
}

export function Setting(props: { label: string; help: string; children: ReactNode }) {
  return (
    <section className={s.setting} aria-label={props.label}>
      <div className={s.settingLabel}>
        <Text strong>{props.label}</Text>
        <Text size="xs" tone="quiet">
          {props.help}
        </Text>
      </div>
      <div className={s.stack}>{props.children}</div>
    </section>
  );
}

function phaseLine(state: HubState): { tone: string; text: string } {
  switch (state.phase) {
    case "live":
      return { tone: "var(--success)", text: "Connected." };
    case "connecting":
      return { tone: "var(--faint)", text: state.attempt > 1 ? `Connecting, attempt ${state.attempt}…` : "Connecting…" };
    case "retrying": {
      const at = new Date(state.retryAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      return { tone: "var(--warning)", text: `Can't reach it: ${sentence(state.reason)} ${state.fix === undefined ? "" : `${state.fix} `}Trying again at ${at}.` };
    }
    case "refused":
      return { tone: "var(--danger)", text: `It refused this app's key: ${sentence(state.message)} Pair again to get a new key.` };
    case "unpaired":
      return { tone: "var(--faint)", text: state.note ?? "This app isn't paired with a hub." };
  }
}

function HubSetting() {
  const state = useData((s) => s.hub);
  const store = useKeyStore();
  const [confirm, setConfirm] = useState(false);
  const hub = state.phase === "unpaired" ? null : state.hub;
  const line = phaseLine(state);
  return (
    <Setting label="Hub" help={`This app acts as you on this hub. ${store === null ? "" : keyStoreLine(store).replaceAll("`", "")}`}>
      {hub ? (
        <Truncate mono size="sm">
          {hub}
        </Truncate>
      ) : null}
      <div className={s.hubLine}>
        <Dot color={line.tone} />
        {/* The hub's fix may name a command in backticks: shown as code. */}
        <Prose tone="quiet" text={line.text} />
      </div>
      <div className={s.inline}>
        <Button
          variant={hub ? "secondary" : "primary"}
          onClick={() => {
            window.location.hash = "#/onboarding";
          }}
        >
          {hub ? "Pair with another hub" : "Pair with a hub"}
        </Button>
        {hub ? (
          <Button variant="ghost" onClick={() => setConfirm(true)}>
            Disconnect and forget key
          </Button>
        ) : null}
      </div>
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Disconnect and forget the key?"
        description="This app stops showing the hub's work until you pair it again with a code from fleetd pair. Agents keep running."
        footer={
          <>
            <Button onClick={() => setConfirm(false)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirm(false);
                void window.fleetd.hub.forget();
              }}
            >
              Disconnect
            </Button>
          </>
        }
      />
    </Setting>
  );
}

/** Whether fleetd:// links (the pairing links `fleetd pair` prints) open this app, and the one action to make them. */
function LinkHandlerSetting() {
  const [status, setStatus] = useState<LinkHandlerStatus | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [refused, setRefused] = useState(false);
  /** A failed check or claim, in words, with the action Try again repeats. */
  const [failed, setFailed] = useState<{ text: string; retry: "check" | "claim" } | null>(null);
  const [checks, setChecks] = useState(0);
  useEffect(() => {
    let live = true;
    window.fleetd.app.linkHandler(null).then(
      (st) => live && setStatus(st),
      (e: unknown) => live && setFailed({ text: `Couldn't find out which app opens fleetd:// links: ${sentence(errorText(e))}`, retry: "check" }),
    );
    return () => {
      live = false;
    };
  }, [checks]);
  const check = () => {
    setFailed(null);
    setChecks((n) => n + 1);
  };
  const claim = () => {
    setFailed(null);
    setClaiming(true);
    window.fleetd.app.linkHandler("user").then(
      (st) => {
        setClaiming(false);
        setStatus(st);
        setRefused(!st.handler);
      },
      (e: unknown) => {
        setClaiming(false);
        setFailed({ text: `Couldn't ask the system to make fleetd the handler: ${sentence(errorText(e))}`, retry: "claim" });
      },
    );
  };
  return (
    <Setting label="Pairing links" help="Open fleetd:// links (pairing links) in this app.">
      {failed ? (
        <div className={s.stack}>
          <Text tone="danger">{failed.text}</Text>
          <div>
            <Button onClick={failed.retry === "check" ? check : claim}>Try again</Button>
          </div>
        </div>
      ) : status === null ? (
        <Text tone="quiet">Checking…</Text>
      ) : status.handler ? (
        <div className={s.hubLine}>
          <Dot color="var(--success)" />
          <Text tone="quiet">fleetd opens them.</Text>
        </div>
      ) : (
        <>
          <div className={s.inline}>
            <Button disabled={!status.packaged || claiming} onClick={claim}>
              {claiming ? "Asking the system…" : "Make fleetd the handler"}
            </Button>
          </div>
          <Text size="xs" tone="quiet">
            {refused
              ? "The system left fleetd:// links with another app. Try again, or pair by typing the code from fleetd pair (Pair with another hub, above)."
              : status.packaged
                ? "fleetd doesn't open fleetd:// links now: another app does, or none."
                : "Dev builds don't register for fleetd:// links; an installed fleetd does."}
          </Text>
        </>
      )}
    </Setting>
  );
}

export function formatBytes(b: number): string {
  const n = Math.max(0, b);
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  if (n < 10 * 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n < 1024 ** 3) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

const daysLabel = (d: number) => (d === 365 ? "1 year" : d === 1 ? "1 day" : `${d} days`);

function RetentionSetting() {
  const live = useLive();
  // The retention and the stored size come with any breakdown; the fleet's last hour (from when the page opened)
  // is the cheapest one.
  const [since] = useState(() => new Date(Date.now() - 3_600_000).toISOString());
  const [store, reload] = useRead("time_breakdown", { scope: { kind: "fleet" }, since }, live);
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const [saving, setSaving] = useState<number | null>(null);
  const [echo, setEcho] = useState<{ ok: boolean; text: string } | null>(null);
  const help = "How long the hub keeps the time inspector's detailed spans. Daily totals and critical paths stay 400 days.";
  if (!live) {
    return (
      <Setting label="Time data" help={help}>
        <Text tone="quiet">Connect to a hub to see and change this.</Text>
      </Setting>
    );
  }
  if (store.state !== "ready") {
    return (
      <Setting label="Time data" help={help}>
        {store.state === "loading" ? (
          <Text tone="quiet">Asking the hub…</Text>
        ) : (
          <div className={s.inline}>
            <Text tone="danger">{store.message}</Text>
            <Button onClick={reload}>Try again</Button>
          </div>
        )}
      </Setting>
    );
  }
  const days = saving ?? store.value.retentionDays;
  const options = (RETENTION as ReadonlyArray<number>).includes(days) ? RETENTION : [...RETENTION, days].sort((a, b) => a - b);
  return (
    <Setting label="Time data" help={help}>
      <div className={s.inline}>
        <label htmlFor="retention" className={textClass({})}>
          Keep spans for
        </label>
        <Select
          id="retention"
          value={String(days)}
          disabled={saving !== null}
          options={options.map((d) => ({ value: String(d), label: daysLabel(d) }))}
          onValueChange={(v) => {
            const d = Number(v);
            setSaving(d);
            setEcho(null);
            hubCall("time_retention_set", { retentionDays: d }).then(
              (o) => {
                setSaving(null);
                setEcho({ ok: true, text: `Saved: ${daysLabel(o.retentionDays)}. Older spans go at the next hourly prune.` });
                refetch(["time_breakdown"]);
              },
              (e: unknown) => {
                setSaving(null);
                setEcho({ ok: false, text: errorText(e) });
              },
            );
          }}
        />
      </div>
      <Text size="xs" tone="quiet">
        Stored now: {formatBytes(store.value.storedBytes)} on the hub, about 20 MB a day of work. Only an admin key can change this; the CLI's{" "}
        <InlineCode>fleetd time --retention &lt;days&gt;</InlineCode> does the same.
      </Text>
      {echo ? (
        <Text size="xs" tone={echo.ok ? "quiet" : "danger"}>
          {echo.text}
        </Text>
      ) : null}
    </Setting>
  );
}
