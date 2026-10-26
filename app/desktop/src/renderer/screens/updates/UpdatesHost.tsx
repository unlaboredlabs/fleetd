// Mounted once by the shell: the updates sheet, and the commands that reach it (the palette, the app menu's
// "Check for Updates…"). The sheet's one Update button updates the hub, then every machine's node, then this app,
// and shows each part's progress and result; this app's own update keeps its own action too.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button, copyText, Dialog, InlineCode, Text } from "../../ui";
import { useDataLayer } from "../../src/data/react";
import { useCommands } from "../palette";
import { useUpdatesView } from "./hooks";
import { splitLabels, type Notes as NotesOf } from "../../../shared/updates";
import { loadRun, startUpdate, type FlowDeps } from "./flow";
import type { AppAction, AppPart, HubPart, PartRow, UpdatesView } from "./model";
import { appUpdate, setUpdatesOpen, useAppUpdate, useUpdatesOpen } from "./state";
import s from "./updates.module.css";
import { Boundary } from "../../src/Boundary";

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
  return <>{parts.map((part, i) => (i % 2 === 1 && i < parts.length - 1 ? <InlineCode key={i}>{part}</InlineCode> : <Labels key={i} text={part} />))}</>;
}

/** A nightly's label names its build commit: marked as version text, so only it is exempt from the hash rule. */
function Labels({ text }: { text: string }) {
  return (
    <>
      {splitLabels(text).map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} data-version>
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
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

/** A raw version, small and selectable, with Copy: what a bug report or `fleetd update --channel` wants. */
function Raw({ version }: { version: string | undefined }) {
  const [copied, setCopied] = useState(false);
  if (version === undefined) return null;
  return (
    <div className={s.raw} data-version>
      <Text mono size="xs" tone="quiet">
        {version}
      </Text>
      <Button variant="ghost" size="sm" onClick={() => void copyText(version).then(setCopied)} onBlur={() => setCopied(false)}>
        {copied ? "Copied" : "Copy version"}
      </Button>
    </div>
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
        <Text strong>
          <Line text={title} />
        </Text>
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

/** `quiet`: the one Update button is there, or its run goes on, so this app's own action steps back. */
function AppSection({ part, quiet }: { part: AppPart; quiet: boolean }) {
  const { action } = part;
  return (
    <section className={s.part} aria-label="This app" data-updates-part="app">
      <Head title={part.title} detail={part.detail}>
        {action === undefined ? undefined : (
          <Button variant={action.primary && !quiet ? "primary" : "secondary"} disabled={part.busy === true} onClick={() => runApp(action.run)}>
            {action.label}
          </Button>
        )}
      </Head>
      <Raw version={part.raw} />
      {part.command === undefined ? null : <Command command={part.command} />}
      <Notes notes={part.notes} />
    </section>
  );
}

/** The hub or a machine: its name, where it stands or how its update goes, and its raw version. */
function Row({ row }: { row: PartRow }) {
  return (
    <li className={s.row} data-updates-row={row.key}>
      <Text size="sm" strong>
        {row.name}
      </Text>
      <Text size="sm" tone={row.tone === "quiet" ? "quiet" : row.tone}>
        <Line text={row.status} />
      </Text>
      <Raw version={row.raw} />
    </li>
  );
}

function HubSection({ part, nodes }: { part: HubPart; nodes: UpdatesView["nodes"] }) {
  return (
    <section className={s.part} aria-label="The hub and its machines" data-updates-part="hub">
      <ul className={s.rows}>
        <Row row={part} />
        {nodes.map((node) => (
          <Row key={node.key} row={node} />
        ))}
      </ul>
      <Notes notes={part.notes} />
      <Text size="xs" tone="faint">
        <Line text="A machine without the app updates with `fleetd update`." />
      </Text>
    </section>
  );
}

/** The one Update button, or the run's progress and how it ended. */
function UpdateAll({ view, deps }: { view: UpdatesView; deps: FlowDeps }) {
  if (view.update === null && view.progress === null) return null;
  return (
    <section className={s.part} aria-label="Update" data-updates-part="all">
      {view.update === null ? null : (
        <Head title="Update fleetd" detail={view.update.note}>
          <Button variant="primary" onClick={() => void startUpdate(deps)}>
            {view.update.label}
          </Button>
        </Head>
      )}
      {view.progress === null ? null : (
        <div role={view.progress.tone === "danger" ? "alert" : "status"}>
          <Text size="sm" tone={view.progress.tone === "quiet" ? "default" : view.progress.tone} strong>
            <Line text={view.progress.text} />
          </Text>
        </div>
      )}
    </section>
  );
}

export function UpdatesHost() {
  const open = useUpdatesOpen();
  const view = useUpdatesView();
  const ready = useAppUpdate()?.app.kind === "ready";
  const layer = useDataLayer();
  const deps = useMemo(
    (): FlowDeps => ({
      call: layer.call,
      retry: () => layer.retryNow(),
      sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      app: {
        state: appUpdate,
        check: () => void window.fleetd.updates.check(),
        install: () => void window.fleetd.updates.install(),
      },
    }),
    [layer],
  );
  // The hub's last run: one going on (the app restarted mid-update, or another window started it) is followed.
  useEffect(() => {
    if (open) void loadRun(deps);
  }, [open, deps]);

  useCommands(
    [
      {
        id: "app.checkForUpdates",
        title: "Check for updates",
        detail: "The hub, its machines and this app",
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
    <Boundary part="the updates sheet" overlay={{ onError: () => setUpdatesOpen(false) }}>
      <Dialog open onOpenChange={setUpdatesOpen} title="Updates">
        <div className={s.parts} data-screen="updates">
          <UpdateAll view={view} deps={deps} />
          {view.hub === null ? null : <HubSection part={view.hub} nodes={view.nodes} />}
          {view.app === null ? null : <AppSection part={view.app} quiet={view.update !== null || view.going} />}
        </div>
      </Dialog>
    </Boundary>
  );
}
