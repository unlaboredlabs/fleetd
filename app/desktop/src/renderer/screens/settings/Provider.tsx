// A provider the team connects with its own key, as Hub › Machines' Providers lists every one of them (fleetd's computers): one
// row, its state a dot, what it can run quietly beside its name. Not connected, Connect; it opens
// the key's sealed field in the row. Connected, what it has to set (a sandbox provider's limit) and one menu with Test
// and Disconnect; the line under its name says only what a check found, or while a run goes.
// The key goes to main, which seals it to the hub's own key and calls the hub's connect: it never reaches the hub in
// the clear and is never shown again.
import { Ellipsis } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { TextTone } from "../../ui";
import { Button, cx, Input, Menu, MenuContent, MenuItem, MenuTrigger, Text } from "../../ui";
import { errorText } from "./hub";
import { SettingsRow, type Mark } from "./parts";
import { keyOf } from "./sandboxModel";
import s from "./settings.module.css";

type Busy = "test" | "disconnect" | "set" | null;

/** A run on a connected provider (Test, Disconnect, a change), and what it found, for its row's line. */
export function useProviderRun(reread: () => Promise<unknown>) {
  const [busy, setBusy] = useState<Busy>(null);
  const [checked, setChecked] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const run = (what: Exclude<Busy, null>, go: () => Promise<unknown>, failed: string) => {
    setBusy(what);
    setProblem(null);
    setChecked(false);
    void go()
      .then(
        () => setChecked(what === "test"),
        (e: unknown) => setProblem(`${failed}: ${errorText(e)}`),
      )
      .then(reread)
      .finally(() => setBusy(null));
  };
  return { busy, checked, problem, run, setChecked };
}

const RUNNING: Readonly<Record<Exclude<Busy, null>, string | null>> = { test: "Testing…", disconnect: "Disconnecting…", set: null };

export function ProviderRow(props: {
  name: string;
  /** What it can run, quietly beside its name (providersModel, canWords). */
  can?: string | undefined;
  reveal: string;
  hint?: string | undefined;
  connected: boolean;
  mark: Mark;
  /** The dot's words for assistive tech; absent: connected, its key failed, or not connected. */
  markLabel?: string | undefined;
  /** Its state or what its last check found: the row's line, with the one button that fixes it; null for none. */
  line: { node: ReactNode; tone?: TextTone | undefined; action?: ReactNode } | null;
  /** Connected: what it has to set, before its menu. */
  setting?: ReactNode;
  busy: Busy;
  onTest: () => void;
  onDisconnect: () => void;
  connecting: boolean;
  onConnect: () => void;
  /** The key's form, while connecting. */
  form: ReactNode;
  data?: Readonly<Record<`data-${string}`, string | undefined>>;
}) {
  const running = props.busy === null ? null : RUNNING[props.busy];
  const line = running !== null ? { node: <span role="status">{running}</span>, tone: "quiet" as const } : props.line;
  const control = props.connected ? (
    <div className={s.inline}>
      {props.setting}
      <Menu>
        <MenuTrigger asChild disabled={props.busy !== null}>
          <Button size="sm" variant="ghost" iconOnly aria-label={`${props.name}: more`} title="More">
            <Ellipsis size={16} aria-hidden />
          </Button>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem onSelect={props.onTest}>Test</MenuItem>
          <MenuItem danger onSelect={props.onDisconnect}>
            Disconnect
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  ) : props.connecting ? undefined : (
    <Button size="sm" onClick={props.onConnect}>
      Connect
    </Button>
  );
  return (
    <SettingsRow
      reveal={props.reveal}
      mark={props.mark}
      markLabel={
        props.markLabel ?? (props.connected ? (props.mark === "failed" ? `${props.name}: its key failed` : `${props.name}: connected`) : `${props.name}: not connected`)
      }
      title={
        props.can === undefined ? (
          props.name
        ) : (
          <span className={s.titleMeta}>
            {props.name}
            <Text size="sm" tone="quiet">
              {props.can}
            </Text>
          </span>
        )
      }
      label={props.name}
      hint={props.hint}
      line={line?.node ?? null}
      lineTone={line?.tone}
      lineAction={running === null ? props.line?.action : undefined}
      control={control}
      data={props.data}
    >
      {props.connecting && !props.connected ? props.form : null}
    </SettingsRow>
  );
}

/**
 * The key's one field, its characters shown as dots, with Connect and Cancel. What was typed goes to main only (`seal`).
 */
export function ConnectKey(props: {
  name: string;
  seal: (key: string) => Promise<{ ok: true } | { ok: false; error: { message: string; fix?: string | undefined } }>;
  reread: () => Promise<unknown>;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typed = keyOf(key);
  const submit = async () => {
    if (typed === null || busy) return;
    setBusy(true);
    setError(null);
    const out = await props.seal(typed);
    if (!out.ok) {
      setBusy(false);
      setError(out.error.fix === undefined ? out.error.message : `${out.error.message} ${out.error.fix}`);
      return;
    }
    setKey("");
    await props.reread();
    setBusy(false);
    props.onDone();
  };
  return (
    <form
      className={s.inline}
      aria-label={`Connect ${props.name}`}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Input
        mono
        aria-label={`${props.name} API key`}
        className={cx(s.secretValue, s.keyField)}
        data-secret=""
        value={key}
        placeholder={`${props.name} API key`}
        autoComplete="off"
        spellCheck={false}
        autoFocus
        disabled={busy}
        onChange={(e) => setKey(e.target.value)}
      />
      <Button type="submit" size="sm" variant="primary" disabled={typed === null || busy}>
        {busy ? "Connecting…" : "Connect"}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={props.onCancel}>
        Cancel
      </Button>
      {error === null ? null : (
        <span role="alert" className={s.keyError}>
          <Text size="sm" tone="danger">
            {error}
          </Text>
        </span>
      )}
    </form>
  );
}
