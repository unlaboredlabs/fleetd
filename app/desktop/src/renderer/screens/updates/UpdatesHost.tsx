// Mounted once by the shell: the updates sheet, and the commands that reach it (the palette, the app menu's
// "Check for Updates…"). The sheet shows this app's update and the hub's, each with its one action.
import { useState, type ReactNode } from "react";
import { Button, copyText, Dialog, InlineCode, Text } from "../../ui";
import { useDataLayer } from "../../src/data/react";
import { hubUpdate, restartStops, type HubUpdateWhen } from "../../src/data/hub-update-contract";
import { useCommands } from "../palette";
import { useUpdatesView } from "./hooks";
import type { Notes as NotesOf } from "../../../shared/updates";
import type { AppAction, AppPart, HubAction, HubPart } from "./model";
import { appUpdate, setUpdatesOpen, useAppUpdate, useUpdatesOpen } from "./state";
import s from "./updates.module.css";

const UNKNOWN_WORK = "Whatever is running on the hub: it couldn't say what that is right now";

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

function Command({ command, note }: { command: string; note?: string | undefined }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      {note === undefined ? null : (
        <Text size="sm" tone="quiet">
          {note}
        </Text>
      )}
      <div className={s.command}>
        <Text mono size="sm">
          {command}
        </Text>
        <Button variant="ghost" onClick={() => void copyText(command).then(setCopied)} onBlur={() => setCopied(false)}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </>
  );
}

function Notes({ notes }: { notes: NotesOf }) {
  if (notes.lines.length === 0) return null;
  return (
    <>
      <Text size="xs" tone="quiet" strong>
        What’s new
      </Text>
      <ul className={s.notes}>
        {notes.lines.map((note, i) => (
          <li key={i}>
            <Text size="sm">
              <Line text={note} />
            </Text>
          </li>
        ))}
        {notes.more ? (
          <li>
            <Text size="sm" tone="quiet">
              And more
            </Text>
          </li>
        ) : null}
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
  // "Restart the hub now" asks first, naming what a restart would stop, from the hub's own answer.
  const [stopping, setStopping] = useState<readonly string[] | null>(null);

  const send = async (when: HubUpdateWhen): Promise<boolean> => {
    setBusy(true);
    setError(null);
    const outcome = await hubUpdate(call, when);
    setBusy(false);
    if (!outcome.ok) setError(outcome.error.message);
    return outcome.ok;
  };
  const askNow = async () => {
    setBusy(true);
    setError(null);
    const stops = await restartStops(call);
    setBusy(false);
    // A hub that can't say what runs still gets asked: the restart would stop whatever does.
    if (!stops.ok) setStopping([UNKNOWN_WORK]);
    else if (stops.value.length > 0) setStopping(stops.value);
    else await send("now");
  };
  const run = async (action: HubAction) => {
    if (action === "cancel") {
      setStopping(null);
      await send("cancel");
    } else if (action === "now") await askNow();
    else await send("idle");
  };

  return (
    <section className={s.part} aria-label="The hub" data-updates-part="hub">
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
          <Text size="sm" strong>
            Restarting the hub now stops:
          </Text>
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
                void send("now").then((ok) => {
                  if (ok) setStopping(null);
                })
              }
            >
              Restart the hub now
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
      {part.command === undefined || (part.actions.length > 0 && error === null) ? null : <Command command={part.command.text} note={part.command.note} />}
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
        detail: "This app and the hub",
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
