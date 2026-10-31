// The updates sheet's content, laid out from the view: one overall state with the Update button and what's new (or a
// quiet Start over beside a run that stopped moving), one line per part (the hub, each machine, Claude Code, this app) with Retry on one that failed, and every part's steps
// behind Details. Hairlines between lines, no boxes; still, never an animation.
import { ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button, copyText, InlineCode, Text } from "../../ui";
import { splitLabels, type Notes as NotesOf } from "../../../shared/updates";
import type { AppAction, AppPart, HubPart, PartLine, PartRow, Retry, UpdatesView } from "./model";
import s from "./updates.module.css";

/** Inline `code` in a plain line, as the release notes and the hub's lines may carry. */
export function Line({ text }: { text: string }) {
  const parts = text.split("`");
  return <>{parts.map((part, i) => (i % 2 === 1 && i < parts.length - 1 ? <InlineCode key={i}>{part}</InlineCode> : <Labels key={i} text={part} />))}</>;
}

/** An Edge build's label names its build commit: marked as version text, so only it is exempt from the hash rule. */
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

export function Notes({ notes }: { notes: NotesOf }) {
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

/** This app's own words and action, behind Details: the one Update button leads, so its action steps back. */
export function AppSection({ part, onApp }: { part: AppPart; onApp: (action: AppAction) => void }) {
  const { action } = part;
  return (
    <section className={s.step} aria-label="This app" data-updates-part="app">
      <Head title={part.title} detail={part.detail}>
        {action === undefined ? undefined : (
          <Button variant="secondary" disabled={part.busy === true} onClick={() => onApp(action.run)}>
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

export function HubSection({ part, nodes }: { part: HubPart; nodes: UpdatesView["nodes"] }) {
  return (
    <section className={s.step} aria-label="The hub and its machines" data-updates-part="hub">
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

function Overall({ view, onUpdate, onStartOver, onUpdateNow }: { view: UpdatesView; onUpdate: () => void; onStartOver: () => void; onUpdateNow: () => void }) {
  const { update, progress, startOver, updateNow } = view;
  if (update === null && progress === null) return null;
  return (
    <section className={s.overall} aria-label="Update" data-updates-part="all">
      <div className={s.head}>
        <div className={s.words}>
          {progress === null ? null : (
            <div role={progress.tone === "danger" ? "alert" : "status"}>
              <Text tone={progress.tone === "quiet" ? "default" : progress.tone} strong>
                <Line text={progress.text} />
              </Text>
            </div>
          )}
          {update === null || progress !== null ? null : (
            <Text strong>
              <Line text={update.title} />
            </Text>
          )}
          {update === null ? null : (
            <Text size="sm" tone="quiet">
              {update.note}
            </Text>
          )}
          {startOver === null ? null : (
            <Text size="sm" tone="quiet" data-updates-start-over>
              {startOver.note}
            </Text>
          )}
        </div>
        {update === null ? null : (
          <div className={s.actions}>
            <Button variant="primary" onClick={onUpdate}>
              {update.label}
            </Button>
          </div>
        )}
        {startOver === null ? null : (
          <div className={s.actions}>
            <Button variant="ghost" onClick={onStartOver}>
              Start over
            </Button>
          </div>
        )}
        {!updateNow ? null : (
          <div className={s.actions}>
            <Button variant="ghost" onClick={onUpdateNow} data-updates-now>
              Update now
            </Button>
          </div>
        )}
      </div>
      {update === null || progress !== null ? null : <Notes notes={update.notes} />}
    </section>
  );
}

/** One part in one line: its name, its state in a word or two, why in one line, and Retry. */
function PartLineRow({ line, onRetry }: { line: PartLine; onRetry: (retry: Retry) => void }) {
  const { retry } = line;
  return (
    <li className={s.line} data-updates-line-of={line.key} data-state={line.tone}>
      <Text size="sm" strong className={s.lineName}>
        {line.name}
      </Text>
      <span className={s.lineSays} title={line.reason}>
        <Text size="sm" tone={line.tone === "quiet" ? "default" : line.tone}>
          {line.state}
        </Text>
        {line.reason === undefined ? null : (
          <Text size="sm" tone="quiet" className={s.lineWhy}>
            <Line text={line.reason} />
          </Text>
        )}
      </span>
      {retry === undefined ? null : (
        <Button variant="ghost" onClick={() => onRetry(retry)}>
          {line.label ?? "Retry"}
        </Button>
      )}
    </li>
  );
}

export interface SheetProps {
  readonly view: UpdatesView;
  readonly onUpdate: () => void;
  /** Start over: ends a run that stopped moving and starts a new one. */
  readonly onStartOver: () => void;
  /** Update now: the machines waiting for their agents restart without waiting. */
  readonly onUpdateNow: () => void;
  readonly onRetry: (retry: Retry) => void;
  readonly onApp: (action: AppAction) => void;
  /** Details shown at first; a test opens them. */
  readonly details?: boolean;
}

export function UpdatesSheet({ view, onUpdate, onStartOver, onUpdateNow, onRetry, onApp, details = false }: SheetProps) {
  const [open, setOpen] = useState(details);
  return (
    <div className={s.parts} data-screen="updates">
      <Overall view={view} onUpdate={onUpdate} onStartOver={onStartOver} onUpdateNow={onUpdateNow} />
      {view.lines.length === 0 ? null : (
        <ul className={s.lines} aria-label="Each part">
          {view.lines.map((line) => (
            <PartLineRow key={line.key} line={line} onRetry={onRetry} />
          ))}
        </ul>
      )}
      <div>
        <Button variant="quiet" aria-expanded={open} icon={<ChevronRight className={s.chevron} data-open={open} />} onClick={() => setOpen(!open)}>
          Details
        </Button>
      </div>
      {open ? (
        <div className={s.details} data-updates-details>
          {view.hub === null ? null : <HubSection part={view.hub} nodes={view.nodes} />}
          {view.app === null ? null : <AppSection part={view.app} onApp={onApp} />}
        </div>
      ) : null}
    </div>
  );
}
