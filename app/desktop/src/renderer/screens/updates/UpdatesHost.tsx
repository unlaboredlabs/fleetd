// Mounted once by the shell: the updates sheet, and the commands that reach it (the palette, the app menu's
// "Check for Updates…"). The sheet shows this app's update and the hub machine's, each with its one action.
import { useState, type ReactNode } from "react";
import { Button, copyText, Dialog, InlineCode, Text } from "../../ui";
import { useDataLayer } from "../../src/data/react";
import { hubUpdate, type HubUpdateWhen } from "../../src/data/hub-version-contract";
import { useCommands } from "../palette";
import { useUpdatesView } from "./hooks";
import type { AppAction, AppPart, HubAction, HubPart } from "./model";
import { appUpdate, setUpdatesOpen, useAppUpdate, useUpdatesOpen } from "./state";
import s from "./updates.module.css";

const runApp = (action: AppAction): void => {
  if (action === "check") void window.fleetd.updates.check();
  // Restarting closes the window; the composer saves every draft as the page goes (pagehide).
  else if (action === "install") void window.fleetd.updates.install();
  else void window.fleetd.updates.keep();
};

/** Found already, or nothing to find: a check would only repeat it. */
const settled = (): boolean => {
  const kind = appUpdate()?.app.kind;
  return kind === "available" || kind === "ready" || kind === "manual" || kind === "checking" || kind === "unsupported";
};

/** Inline `code` in a plain line, as the release notes and the hub's lines may carry. */
function Line({ text }: { text: string }) {
  const parts = text.split("`");
  return <>{parts.map((part, i) => (i % 2 === 1 && i < parts.length - 1 ? <InlineCode key={i}>{part}</InlineCode> : part))}</>;
}

function Command({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={s.command}>
      <Text mono size="sm">
        {command}
      </Text>
      <Button variant="ghost" onClick={() => void copyText(command).then(setCopied)} onBlur={() => setCopied(false)}>
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

function Notes({ notes }: { notes: readonly string[] }) {
  if (notes.length === 0) return null;
  return (
    <>
      <Text size="xs" tone="quiet" strong>
        What’s new
      </Text>
      <ul className={s.notes}>
        {notes.map((note, i) => (
          <li key={i}>
            <Text size="sm">
              <Line text={note} />
            </Text>
          </li>
        ))}
      </ul>
    </>
  );
}

function Head({ title, detail, children }: { title: string; detail: string | undefined; children?: ReactNode }) {
  return (
    <div className={s.head}>
      <div className={s.words}>
        <Text strong>{title}</Text>
        {detail === undefined ? null : (
          <Text size="sm" tone="quiet" tabular>
            <Line text={detail} />
          </Text>
        )}
      </div>
      {children === undefined ? null : <div className={s.actions}>{children}</div>}
    </div>
  );
}

function AppSection({ part }: { part: AppPart }) {
  const { action } = part;
  return (
    <section className={s.part} aria-label="This app" data-updates-part="app">
      <Head title={part.title} detail={part.detail}>
        {action === undefined ? undefined : (
          <Button variant={action.primary ? "primary" : "secondary"} disabled={part.busy === true} onClick={() => runApp(action.run)}>
            {action.label}
          </Button>
        )}
      </Head>
      {part.command === undefined ? null : <Command command={part.command} />}
      <Notes notes={part.notes} />
    </section>
  );
}

function HubSection({ part }: { part: HubPart }) {
  const { call } = useDataLayer();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // "Update now" asks first: what a restart would stop, from the hub's own answer.
  const [stopping, setStopping] = useState<readonly string[] | null>(null);

  const send = async (when: HubUpdateWhen) => {
    setBusy(true);
    setError(null);
    const outcome = await hubUpdate(call, when);
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.error.message);
      return null;
    }
    return outcome.output;
  };
  const run = async (action: HubAction) => {
    if (action === "cancel") {
      setStopping(null);
      await send("cancel");
    } else if (action === "now") {
      // Asking again with "idle" changes nothing for an update already waiting, and says what still runs.
      const output = await send("idle");
      if (output !== null && output.running.length > 0) setStopping(output.running);
    } else await send("idle");
  };

  return (
    <section className={s.part} aria-label={`fleetd on ${part.machine}`} data-updates-part="hub">
      <Head title={part.title} detail={part.detail}>
        {part.actions.length === 0 || stopping !== null
          ? undefined
          : part.actions.map((a) => (
              <Button key={a.run} variant={a.primary ? "primary" : "secondary"} disabled={busy || part.working} onClick={() => void run(a.run)}>
                {a.label}
              </Button>
            ))}
      </Head>
      {stopping === null ? null : (
        <div className={s.confirm} role="alert">
          <Text size="sm" strong>{`Updating now restarts fleetd on ${part.machine} and stops:`}</Text>
          <ul className={s.notes}>
            {stopping.map((line, i) => (
              <li key={i}>
                <Text size="sm">
                  <Line text={line} />
                </Text>
              </li>
            ))}
          </ul>
          <div className={s.actions}>
            <Button variant="secondary" disabled={busy} onClick={() => setStopping(null)}>
              Keep waiting
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                void send("now").then((output) => {
                  if (output !== null) setStopping(null);
                })
              }
            >
              Stop and update
            </Button>
          </div>
        </div>
      )}
      {error === null ? null : (
        <div role="alert">
          <Text size="sm" tone="danger">
            <Line text={error} />
          </Text>
        </div>
      )}
      {part.command === undefined ? null : <Command command={part.command} />}
      <Notes notes={part.notes} />
    </section>
  );
}

export function UpdatesHost() {
  const open = useUpdatesOpen();
  const view = useUpdatesView();
  const ready = useAppUpdate()?.app.kind === "ready";

  useCommands(
    [
      {
        id: "app.checkForUpdates",
        title: "Check for updates",
        detail: "This app and fleetd on the hub’s machine",
        group: "actions",
        keywords: ["update", "upgrade", "version", "what's new"],
        run: () => {
          setUpdatesOpen(true);
          if (!settled()) runApp("check");
        },
      },
      { id: "app.restartToUpdate", title: "Restart to update", group: "actions", keywords: ["update", "install"], enabled: () => ready, run: () => runApp("install") },
    ],
    [ready],
  );

  if (!open) return null;
  return (
    <Dialog open onOpenChange={setUpdatesOpen} title="Updates">
      <div className={s.parts} data-screen="updates">
        {view.app === null ? null : <AppSection part={view.app} />}
        {view.hub === null ? null : <HubSection part={view.hub} />}
      </div>
    </Dialog>
  );
}
