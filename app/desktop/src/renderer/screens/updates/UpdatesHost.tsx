// Mounted once by the shell: the updates sheet, and the commands that reach it (the palette, the app menu's
// "Check for Updates…"). The sheet shows this app's update and the hub's, each with its one action.
import { useState, type ReactNode } from "react";
import { Button, copyText, Dialog, InlineCode, Text } from "../../ui";
import { useDataLayer } from "../../src/data/react";
import { useCommands } from "../palette";
import { useUpdatesView } from "./hooks";
import type { SetupOutcome } from "../../../shared/pairing";
import type { Notes as NotesOf } from "../../../shared/updates";
import type { AppAction, AppPart, HubPart } from "./model";
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

/** What runs on the hub now (hub_info), asked when the person chooses Update the hub. */
type Running = { readonly kind: "asking" } | { readonly kind: "known"; readonly items: readonly string[] } | { readonly kind: "unknown"; readonly reason: string };

function RunningNow({ running }: { running: Running }) {
  if (running.kind === "asking") {
    return (
      <Text size="sm" tone="quiet">
        Asking the hub what's running…
      </Text>
    );
  }
  if (running.kind === "unknown") {
    return (
      <Text size="sm" tone="warning">
        {`The hub couldn't say what's running: ${running.reason}`}
      </Text>
    );
  }
  if (running.items.length === 0) return <Text size="sm">Nothing is running on the hub, so it restarts as soon as the update is in.</Text>;
  return (
    <div className={s.confirm}>
      <Text size="sm" strong>
        Running on the hub now, so it waits for these:
      </Text>
      <ul className={s.notes}>
        {running.items.map((line, i) => (
          <li key={i}>
            <Text size="sm">
              <Line text={line} />
            </Text>
          </li>
        ))}
      </ul>
    </div>
  );
}

function HubSection({ part }: { part: HubPart }) {
  const { call } = useDataLayer();
  const [running, setRunning] = useState<Running | null>(null);
  const [opened, setOpened] = useState<SetupOutcome | null>(null);
  const { update } = part;

  const reveal = async () => {
    setRunning({ kind: "asking" });
    const outcome = await call("hub_info", {});
    setRunning(outcome.ok ? { kind: "known", items: outcome.output.busy.map((item) => item.text) } : { kind: "unknown", reason: outcome.error.message });
  };

  return (
    <section className={s.part} aria-label="The hub" data-updates-part="hub">
      <Head title={part.title} detail={part.detail}>
        {update === undefined || running !== null ? undefined : (
          <Button variant="primary" onClick={() => void reveal()}>
            Update the hub
          </Button>
        )}
      </Head>
      {update === undefined || running === null ? null : (
        <>
          <RunningNow running={running} />
          <Command command={update.command} note={update.note} />
          {update.terminal ? (
            <div className={s.actions}>
              <Button variant="secondary" onClick={() => void window.fleetd.updates.hubTerminal().then(setOpened)}>
                Run in Terminal
              </Button>
            </div>
          ) : null}
          {opened === null ? null : opened.ok ? (
            <Text size="sm" tone="quiet">
              <Line
                text={`fleetd update is running in ${opened.terminal}; its result shows there. If something is running on the hub, the hub keeps its version until you run \`fleetd update --restart-now\` or it next restarts.`}
              />
            </Text>
          ) : (
            <div role="alert">
              <Text size="sm" tone="danger">
                {opened.message}
              </Text>
              <Command command={opened.command} />
            </div>
          )}
        </>
      )}
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
