// New project: a modal over whatever is on screen (ProjectsHost mounts it; the chat, its scroll and the panel behind
// stay as they were). One field: type a name for a new, empty project, or find a repo to add, one of the checkouts on
// your machines or of your GitHub repos, or paste a URL or a folder's path. Below it the list, grouped by where each
// repo is (repos already a project only once the field matches them), and a footer that says in one line what the
// button will do, with Only me beside it. Then the clone's progress, the ready state with what the lead will need (a new
// project opens at once), or the error and its fix. Type to filter, Up/Down pick, Enter adds, Esc closes (a clone
// carries on). Cloud machines and the agents' Mac are never offered: no project lives there (projectHome). With
// several hubs a line beside the title says which hub it adds to, and picks another.

import { Dialog as D } from "radix-ui";
import { Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Button, Checkbox, Dot, Select, Text, Truncate, copyText, cx } from "../../ui";
import { clonePath, discovery as discoveryOf, newPath, onlyMeFirst, orList, plan, projectHome, rows as rowsFor, target, type Discovery, type Failure, type Found, type Plan, type Ready, type Request, type Row, type Worker } from "./discovery";
import { CallError, callKey } from "../../src/data/queries";
import { useData, useDataLayer, useHub, useHubs, useToolQuery } from "../../src/data/react";
import { navigate } from "../shell/navigation";
import type { Job, Phase } from "./flow";
import { HubText } from "./HubText";
import { otherHost, tilde } from "./source";
import {
  addAnother,
  back,
  closeAddProject,
  localMachine,
  openProject,
  pickMachine,
  setFolder,
  setGitInit,
  setOnlyMe,
  setText,
  startAdd,
  useAddUi,
  type AddUi,
  type Note,
} from "./store";
import s from "./projects.module.css";

/** The modal. Its content carries data-screen="projects.add"; the state inside, "projects.add.<state>". */
export function AddProjectScreen() {
  const pick = usePick();
  const phase = pick.ui.add.phase;
  const data = useDataLayer();
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // New checkouts on disk raise no event: look again each time it opens.
    void data.queryClient.invalidateQueries({ queryKey: callKey("project_discover", allRepos) });
  }, [data]);

  const title =
    phase.kind === "working" ? `Adding ${phase.job.what}` : phase.kind === "ready" ? `${phase.ready.title} is ready` : phase.kind === "failed" ? `Couldn't add ${phase.what}` : phase.kind === "unlisted" ? `${phase.what} isn't on the hub yet` : "New project";

  return (
    <D.Root
      open
      onOpenChange={(open) => {
        if (!open) closeAddProject();
      }}
    >
      <D.Portal>
        <D.Overlay className={s.backdrop} />
        <D.Content
          className={cx(s.modal, phase.kind !== "pick" && s.fit)}
          data-screen="projects.add"
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            // Typing starts at once; a state with no field takes the default (its first button).
            if (field.current === null) return;
            e.preventDefault();
            field.current.focus();
          }}
        >
          <div className={s.head}>
            <D.Title className={s.title} data-text="wrap">
              {title}
            </D.Title>
            {phase.kind === "pick" ? <HubPick /> : null}
          </div>
          {phase.kind === "pick" ? (
            <Pick pick={pick} field={field} />
          ) : (
            <>
              <div className={s.body}>
                {phase.kind === "working" ? <Working job={phase.job} /> : null}
                {phase.kind === "ready" ? <ReadyView ready={phase.ready} /> : null}
                {phase.kind === "failed" ? <FailedView failure={phase.failure} /> : null}
                {phase.kind === "unlisted" ? (
                  <div data-screen="projects.add.unlisted">
                    <Text tone="quiet">
                      The connection dropped before the add finished, and the hub doesn&apos;t list {phase.what} yet. If the clone was still running, it appears in the sidebar when it finishes. Machines shows any error.
                    </Text>
                  </div>
                ) : null}
              </div>
              <div className={s.foot}>
                {phase.kind === "ready" ? <ReadyFooter ready={phase.ready} /> : phase.kind === "failed" ? <FailedFooter failure={phase.failure} /> : phase.kind === "unlisted" ? <UnlistedFooter phase={phase} /> : <WorkingFooter />}
              </div>
            </>
          )}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

const allRepos = {};

/**
 * What the hub found, through the data layer: null while it looks. An older hub without project_discover still gets
 * the snapshot's machines, with its error as the one problem.
 */
const useDiscovery = (): Discovery | null => {
  const query = useToolQuery("project_discover", allRepos);
  const machines = useData((s) => s.machines);
  return useMemo(() => {
    const name = (id: string) => machines[id]?.name ?? id;
    const homes = Object.values(machines)
      .filter(projectHome)
      .map((m) => ({ machineId: m.machineId, name: m.name, online: m.status !== "offline" }));
    if (query.data !== undefined) {
      const d = discoveryOf(query.data, name, (id) => projectHome(machines[id]));
      if (d.workers.length > 0) return d;
      return { ...d, workers: homes };
    }
    if (query.error === null) return null;
    const e: { message: string; fix?: string | undefined } = query.error instanceof CallError ? query.error.error : { message: query.error.message };
    return {
      workers: homes,
      found: [],
      problems: [e.fix ? { message: e.message, fix: e.fix } : { message: e.message }],
    };
  }, [query.data, query.error, machines]);
};

type PickData = ReturnType<typeof usePick>;

const usePick = () => {
  const ui = useAddUi();
  const d = useDiscovery();
  const withWorkers = d;
  const { rows, selected: first } = useMemo(() => rowsFor(ui.text, d?.found ?? []), [ui.text, d]);
  // The selection belongs to one list of rows: a keystroke makes new rows, which start on their own first pick.
  const [sel, setSel] = useState<{ rows: ReadonlyArray<Row>; n: number }>({ rows, n: first });
  const selected = sel.rows === rows ? sel.n : first;
  const select = (n: number) => setSel({ rows, n });
  const to = target(withWorkers, ui.machine ?? null);
  const picked = ui.machine;
  const planFor = (r: Row | undefined) => plan(r, withWorkers, to, picked);
  return { ui, d: withWorkers, rows, selected, select, to, planFor };
};

/** A new project's folder on its machine: as the person edited it, else `<projectsRoot>/<name>`; null when unknown. */
const newFolder = (p: Extract<Plan, { kind: "new" }>, d: Discovery | null, ui: AddUi): string | null =>
  ui.folder ?? newPath(d?.workers.find((w) => w.machineId === p.machineId), p.name);

/** Only me for this add: as the person set it, else where it starts for this kind of add. */
const onlyMeOf = (p: Plan, ui: AddUi): boolean => ui.onlyMe ?? onlyMeFirst(p);

const requestFor = (p: Plan, to: Worker | null, folder: string | null, ui: AddUi): { request: Request; path: string } | null => {
  const r = kindRequest(p, to, folder, ui);
  return r === null ? null : { ...r, request: { ...r.request, onlyMe: onlyMeOf(p, ui) } };
};

const kindRequest = (p: Plan, to: Worker | null, folder: string | null, ui: AddUi): { request: Request; path: string } | null => {
  switch (p.kind) {
    case "new": {
      const name = p.name.trim();
      if (p.machineId === undefined || name === "" || folder === null) return null;
      const path = folder.trim().replace(/(.)\/+$/u, "$1");
      return { request: { kind: "new", machineId: p.machineId, name, path, gitInit: ui.gitInit === true }, path };
    }
    case "clone":
      return to ? { request: { kind: "clone", repo: p.repo, machineId: to.machineId, useExisting: false }, path: clonePath(to, p.repo) ?? "" } : null;
    case "folder":
      return { request: { kind: "folder", machineId: p.machineId, path: p.path }, path: p.path };
    default:
      return null;
  }
};

const submit = (p: Plan, pick: Pick_) => {
  if (p.kind === "open") {
    openProject(p.project.machineId, p.project.projectId);
    return;
  }
  const folder = p.kind === "new" ? newFolder(p, pick.d, pick.ui) : null;
  // A typed path must be absolute on the machine: ~ and ./ mean nothing to the hub.
  if ((p.kind === "folder" && !p.path.startsWith("/")) || (p.kind === "new" && !folder?.trim().startsWith("/"))) return;
  const r = requestFor(p, pick.to, folder, pick.ui);
  if (r) startAdd(r.request, r.path);
};

/** What submitting reads of the pick: the machine it goes to, what the hub found, and the modal's own state. */
type Pick_ = Pick<PickData, "to" | "d" | "ui">;

function Pick({ pick, field }: { pick: PickData; field: RefObject<HTMLInputElement | null> }) {
  const { ui, d, rows, selected, select, planFor } = pick;
  const go = () => submit(planFor(rows[selected]), pick);
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (rows.length === 0 && e.key !== "Enter") return;
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      select((selected + 1) % rows.length);
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      select((selected - 1 + rows.length) % rows.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      go();
    }
  };

  return (
    <>
      <div className={s.field}>
        <input
          ref={field}
          className={s.input}
          spellCheck={false}
          aria-label="New project name, GitHub URL, folder path, or filter"
          placeholder="Name a new project, or find a repo"
          value={ui.text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
        />
      </div>
      {ui.note ? <NoteLine note={ui.note} /> : null}
      <div className={s.list} data-screen={d === null ? "projects.add.loading" : rows.length === 0 && ui.text.trim() === "" ? "projects.add.empty" : "projects.add.pick"}>
        {d === null ? (
          <Text as="p" tone="quiet" className={cx(s.quietLine)}>
            Looking for repos on your machines and on GitHub…
          </Text>
        ) : (
          <List d={d} rows={rows} selected={selected} select={select} text={ui.text} go={go} />
        )}
      </div>
      <PickFooter pick={pick} go={go} />
    </>
  );
}

/**
 * With several hubs, which one the project goes to: the hub on screen, or another picked here (the modal stays open,
 * over that hub's home). With one hub, nothing.
 */
function HubPick() {
  const hubs = useHubs();
  const hub = useHub();
  if (hubs.length < 2) return null;
  return (
    <div className={s.hubPick}>
      <Text size="sm" tone="quiet">
        Adds to
      </Text>
      <Select aria-label="Hub" className={s.inlineSelect} value={hub.id} options={hubs.map((h) => ({ value: h.id, label: h.label }))} onValueChange={(at) => navigate({ id: "projects.add", at })} />
    </div>
  );
}

function NoteLine({ note }: { note: Note }) {
  return (
    <Text as="p" size="sm" tone={note.problem ? "warning" : "quiet"} className={cx(s.noteLine)}>
      {note.text}
    </Text>
  );
}

/** This computer as the person knows it: "This Mac" on a Mac. */
const THIS_COMPUTER = window.fleetd.platform === "darwin" ? "This Mac" : "This computer";

/** A row's group: none for what the field itself makes (a new project, a pasted URL or path), else where it is. */
const groupOf = (r: Row, found: ReadonlyArray<Found>, name: (id: string) => string, local: string | undefined): string | null => {
  if (r.kind !== "found") return null;
  const f = found[r.index];
  if (f?.project !== undefined) return "Already projects";
  if (f?.source.kind !== "checkout") return "GitHub";
  return f.source.machineId === local ? `${THIS_COMPUTER} · ${name(f.source.machineId)}` : name(f.source.machineId);
};

function List(props: { d: Discovery; rows: ReadonlyArray<Row>; selected: number; select: (n: number) => void; text: string; go: () => void }) {
  const { d, rows, selected, select, text, go } = props;
  const name = (id: string) => d.workers.find((w) => w.machineId === id)?.name ?? id;
  const local = localMachine()?.machineId;
  if (rows.length === 0) {
    const hint = otherHost(text);
    if (hint) return <Text as="p" tone="warning" className={cx(s.quietLine)}>{hint}</Text>;
    return <Empty d={d} />;
  }
  const groups: Array<{ label: string | null; items: Array<[Row, number]> }> = [];
  rows.forEach((r, i) => {
    const label = groupOf(r, d.found, name, local);
    const last = groups.at(-1);
    if (last !== undefined && last.label === label) last.items.push([r, i]);
    else groups.push({ label, items: [[r, i]] });
  });
  return (
    <>
      <div role="listbox" aria-label="Repos">
        {groups.map((g, n) => (
          <div role="group" key={`${g.label ?? ""}:${String(n)}`} {...(g.label === null ? {} : { "aria-label": g.label })}>
            {g.label === null ? null : (
              <Text as="div" size="xs" tone="quiet" className={cx(s.group)} aria-hidden>
                {g.label}
              </Text>
            )}
            {g.items.map(([r, i]) => (
              <RowView key={rowKey(r, d.found)} row={r} d={d} selected={i === selected} onPick={() => select(i)} onGo={go} />
            ))}
          </div>
        ))}
      </div>
      {rows.length === 1 && rows[0]?.kind === "new" && d.found.length > 0 ? (
        <Text as="p" size="sm" tone="quiet" className={cx(s.quietLine)}>
          No repo matches. To add one, paste its GitHub URL or type its folder&apos;s full path.
        </Text>
      ) : null}
      <Problems d={d} />
    </>
  );
}

const rowKey = (r: Row, found: ReadonlyArray<Found>): string => {
  if (r.kind === "new") return "new";
  if (r.kind !== "found") return `${r.kind}:${r.kind === "clone" ? r.repo : r.path}`;
  const f = found[r.index];
  return f?.source.kind === "checkout" ? `co:${f.source.machineId}:${f.source.path}` : `gh:${f?.name ?? r.index}`;
};

/** One line: the name, then a quiet detail. What the button does is the footer's to say. */
function RowView(props: { row: Row; d: Discovery; selected: boolean; onPick: () => void; onGo: () => void }) {
  const { row, d } = props;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (props.selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [props.selected]);
  let title: string;
  let detail = "";
  let quiet = false;
  if (row.kind === "clone") {
    title = row.repo;
    detail = "from GitHub";
  } else if (row.kind === "new") {
    title = `New project “${row.name}”`;
    detail = "an empty folder, no repo needed";
  } else if (row.kind === "folder") {
    title = row.path;
  } else {
    const f = d.found[row.index];
    title = f?.name ?? "";
    quiet = f?.project !== undefined;
    if (quiet) detail = "opens its chat";
    // A checkout's remote (its path is the footer's to say); a GitHub repo's description.
    else if (f?.source.kind === "checkout") detail = f.detail;
    else detail = [f?.private ? "private" : "", f?.detail ?? ""].filter((x) => x !== "").join(" · ");
  }
  return (
    // The field keeps focus: the rows are its listbox's options, picked by pointer or by Up/Down there.
    <div
      ref={ref}
      role="option"
      aria-selected={props.selected}
      className={cx(s.row, quiet && s.added)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={props.onPick}
      onDoubleClick={props.onGo}
    >
      {row.kind === "new" ? <Plus className={s.rowIcon} aria-hidden /> : null}
      {/* Repo and folder names are the names on disk and on GitHub, shown as they are (samp: machine text). */}
      <Truncate expand="none" as="samp" className={cx(s.name)}>
        {title}
      </Truncate>
      {detail ? (
        <Truncate expand="none" size="sm" tone="quiet" className={cx(s.detail)}>
          {detail}
        </Truncate>
      ) : null}
    </div>
  );
}

function Problems({ d }: { d: Discovery }) {
  if (d.problems.length === 0) return null;
  return (
    <div className={s.problems}>
      {d.problems.map((p) => (
        <div className={s.problem} key={p.message}>
          <Dot color="var(--warning)" />
          <Text size="sm" tone="quiet">
            <HubText>{p.fix ? `${p.message} ${p.fix}` : p.message}</HubText>
          </Text>
        </div>
      ))}
    </div>
  );
}

function Empty({ d }: { d: Discovery }) {
  // gh's own trouble, when the hub reports one, is listed below with its fix.
  const gh =
    d.ghOn !== undefined
      ? `gh on ${d.ghOn} listed nothing new for you or your orgs.`
      : d.problems.length === 0
        ? "GitHub repos aren't listed: gh isn't logged in on the hub or a machine (run gh auth login there)."
        : "";
  return (
    <div className={s.empty}>
      <Text size="sm" tone="quiet">
        No repos to add on {orList(d.workers.map((w) => w.name))}: fleetd looked for git checkouts in ~/src, ~/code, ~/projects and ~/dev, two folders deep. {gh} Paste a GitHub URL or type a folder&apos;s full path to add one.
      </Text>
      <Problems d={d} />
    </div>
  );
}

/**
 * What the button will do, in one sentence, or what keeps it from doing it (the button is off only then). A sentence
 * that ends `on` a machine ends on its name, or on a picker when more than one machine is online.
 */
interface Summary {
  readonly words: ReactNode;
  readonly label: string;
  readonly enabled: boolean;
  readonly on?: string;
}

const At = ({ path }: { path: string }) => (
  <samp className={s.path} title={path}>
    {tilde(path)}
  </samp>
);

const summaryOf = (p: Plan, pick: PickData): Summary => {
  const { d, to, ui } = pick;
  switch (p.kind) {
    case "clone": {
      if (!to) return { words: "No machine is online to clone onto: start a node on one of your machines.", label: "Clone", enabled: false };
      const path = clonePath(to, p.repo);
      return { words: path ? <>Clones {p.repo} into <At path={path} /> on</> : <>Clones {p.repo} into its clone folder on</>, label: "Clone", enabled: true, on: to.machineId };
    }
    case "folder":
      if (p.fixed) return { words: <>Adds <At path={p.path} /> as it is, nothing cloned, on</>, label: "Add project", enabled: true, on: p.machineId };
      if (!p.path.startsWith("/")) return { words: "Type the folder's full path, starting with /.", label: "Add project", enabled: false };
      return { words: <>Adds <At path={p.path} /> as it is on</>, label: "Add project", enabled: true, on: p.machineId };
    case "new": {
      if (p.machineId === undefined) return { words: "No machine is online to make its folder on: start a node on one of your machines.", label: "Create", enabled: false };
      const on = d?.workers.find((w) => w.machineId === p.machineId);
      if (on !== undefined && on.projectsRoot === undefined) {
        const others = (d?.workers ?? []).some((w) => w.online && w.machineId !== on.machineId);
        return others
          ? { words: `Update fleetd on ${on.name} to create a project there, or pick another machine:`, label: "Create", enabled: false, on: p.machineId }
          : { words: `Update fleetd on ${on.name} to create a project there.`, label: "Create", enabled: false };
      }
      const folder = newFolder(p, d, ui) ?? "";
      const full = folder.trim().startsWith("/");
      return {
        words: (
          <>
            {full ? "Creates an empty folder" : "Type the folder's full path, starting with /:"}
            <input
              className={s.folder}
              spellCheck={false}
              aria-label="Folder"
              value={folder}
              size={Math.max(16, Math.min(folder.length, 44))}
              onChange={(e) => setFolder(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                submit(p, pick);
              }}
            />
            on
          </>
        ),
        label: "Create",
        enabled: full,
        on: p.machineId,
      };
    }
    case "open":
      return { words: "Already a project: opens its chat, on", label: "Open", enabled: true, on: p.project.machineId };
    case "nothing":
      return { words: d === null ? "" : "Type a name, paste a GitHub URL, or type a folder's path.", label: "Create", enabled: false };
  }
};

function PickFooter({ pick, go }: { pick: PickData; go: () => void }) {
  const { d, rows, selected, planFor, ui } = pick;
  const p = planFor(rows[selected]);
  const sum = summaryOf(p, pick);
  const adds = p.kind === "new" || p.kind === "folder" || p.kind === "clone";
  const onlyMe = adds && onlyMeOf(p, ui);
  // A checkout or a project is where it is; anything else goes to the machine picked.
  const online = (d?.workers ?? []).filter((w) => w.online);
  const picks = sum.on !== undefined && online.length > 1 && (p.kind === "clone" || p.kind === "new" || (p.kind === "folder" && !p.fixed)) && online.some((w) => w.machineId === sum.on);
  return (
    <div className={s.foot} {...(p.kind === "new" ? { "data-screen": "projects.add.new" } : {})}>
      <Text as="div" size="sm" tone="quiet" className={cx(s.summary)}>
        {sum.words}
        {sum.on === undefined ? null : picks ? (
          <Select aria-label="Machine" className={s.inlineSelect} value={sum.on} options={online.map((w) => ({ value: w.machineId, label: w.name }))} onValueChange={pickMachine} />
        ) : (
          <> {nameOf(pick, sum.on)}.</>
        )}
        {sum.enabled && adds ? <span>{onlyMe ? "Only you will see it." : "Everyone on this hub can use it."}</span> : null}
      </Text>
      <div className={s.actions}>
        {adds ? (
          <Checkbox
            label="Only me"
            title="Only you see and use it: its chat, its agents and its settings. Off, everyone on this hub can."
            checked={onlyMe}
            onCheckedChange={(on) => setOnlyMe(on === true)}
          />
        ) : null}
        {p.kind === "new" && sum.enabled ? <Checkbox label="Start a git repo" checked={ui.gitInit === true} onCheckedChange={(on) => setGitInit(on === true)} /> : null}
        <span className={s.spacer} />
        {localMachine() ? <BrowseButton /> : null}
        <Button onClick={closeAddProject}>Cancel</Button>
        <Button variant="primary" disabled={!sum.enabled} onClick={go}>
          {sum.label}
        </Button>
      </div>
    </div>
  );
}

const nameOf = (pick: PickData, id: string): string => pick.d?.workers.find((w) => w.machineId === id)?.name ?? id;

function BrowseButton() {
  return (
    <Button
      variant="ghost"
      onClick={() => {
        void window.fleetd.projects.pickFolder().then((path) => {
          if (path === null) return;
          const local = localMachine();
          setText(path);
          if (local) pickMachine(local.machineId);
        });
      }}
    >
      Browse…
    </Button>
  );
}

const STEPS: ReadonlyArray<readonly [Job["step"], string, string]> = [
  ["clone", "Clone", "git clone on the machine"],
  ["inspect", "Inspect", "default branch, CI and merge rules"],
  ["register", "Register", "a project, with its own lead"],
];
const ORDER: Record<Job["step"], number> = { clone: 0, inspect: 1, register: 2 };

function Working({ job }: { job: Job }) {
  const name = useData((s) => s.machines[job.machineId]?.name) ?? job.machineId;
  return (
    <div data-screen="projects.add.cloning">
      <Truncate size="sm" tone="quiet" mono>{`${tilde(job.path)} on ${name}`}</Truncate>
      <div className={s.steps}>
        {STEPS.filter(([step]) => (job.create ? step === "register" : job.clone || step !== "clone")).map(([step, label, idle]) => {
          const now = step === job.step;
          const done = ORDER[step] < ORDER[job.step];
          return (
            <div className={s.step} key={step}>
              {done ? <Dot color="var(--success)" label="done" /> : now ? <Dot color="var(--accent)" label="now" /> : <span className={s.ring} aria-hidden />}
              <Text strong={now} tone={now || done ? "default" : "quiet"}>
                {label}
              </Text>
              <Text size="sm" tone="quiet">
                {now ? job.detail : done ? "done" : idle}
              </Text>
              {now && job.fraction !== undefined ? (
                <div className={`${s.stepBar} ${s.bar}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(job.fraction * 100)}>
                  <div className={s.barFill} style={{ transform: `scaleX(${Math.min(Math.max(job.fraction, 0), 1)})` }} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WorkingFooter() {
  return (
    <div className={s.actions}>
      <Text size="sm" tone="quiet" className={cx(s.spacer)}>
        Hide this and carry on: the add keeps going, and a note says when it&apos;s ready.
      </Text>
      <Button variant="primary" onClick={closeAddProject}>
        Hide
      </Button>
    </div>
  );
}

function ReadyView({ ready }: { ready: Ready }) {
  return (
    <div data-screen="projects.add.ready">
      <Truncate size="sm" tone="quiet" mono>{`${tilde(ready.path)} on ${ready.machine}`}</Truncate>
      <dl className={s.facts}>
        {ready.facts.map(([label, value]) => (
          <div key={label} style={{ display: "contents" }}>
            <Text as="dt" size="sm" tone="quiet" className={cx(s.dd)}>
              {label}
            </Text>
            <Text as="dd" className={cx(s.dd)}>
              {value}
            </Text>
          </div>
        ))}
      </dl>
      <div className={s.lead}>
        <Dot color={ready.leadOk ? "var(--success)" : "var(--warning)"} />
        <Text>
          <HubText>{ready.leadLine}</HubText>
        </Text>
      </div>
      {ready.notes.length > 0 ? (
        <Text as="p" size="sm" tone="quiet">
          <HubText>{ready.notes.join(" ")}</HubText>
        </Text>
      ) : null}
    </div>
  );
}

function ReadyFooter({ ready }: { ready: Ready }) {
  return (
    <>
      <Text as="div" size="sm" tone="quiet" className={cx(s.summary)}>
        Open its chat and tell the lead what you want.
      </Text>
      <div className={s.actions}>
        <span className={s.spacer} />
        <Button onClick={addAnother}>Add another</Button>
        <Button variant="primary" onClick={() => openProject(ready.project.machineId, ready.project.projectId)}>
          Open chat
        </Button>
      </div>
    </>
  );
}

function FailedView({ failure }: { failure: Failure }) {
  const [copied, setCopied] = useState(false);
  return (
    <div data-screen="projects.add.error" className={s.error} role="alert">
      <div className={s.errorHead}>
        <Dot color="var(--danger)" />
        <Text>
          <HubText>{failure.message}</HubText>
        </Text>
      </div>
      {failure.fix ? (
        <Text tone="quiet">
          <HubText>{failure.fix}</HubText>
        </Text>
      ) : null}
      <div>
        <Button
          variant="ghost"
          onClick={() => {
            void copyText(failure.fix ? `${failure.message}\n${failure.fix}` : failure.message).then(setCopied);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

function FailedFooter({ failure }: { failure: Failure }) {
  const a = failure.action;
  return (
    <div className={s.actions}>
      <span className={s.spacer} />
      <Button onClick={back}>Back</Button>
      {a ? (
        <Button
          variant="primary"
          onClick={() => {
            if (a.kind === "open") openProject(a.project.machineId, a.project.projectId);
            else startAdd(a.request, a.request.kind === "folder" ? a.request.path : "");
          }}
        >
          {a.kind === "use_existing" ? "Add the existing folder" : "Open project"}
        </Button>
      ) : null}
    </div>
  );
}

/** Done is the way out; sending the add again is a secondary retry, since the first may still be cloning. */
function UnlistedFooter({ phase }: { phase: Extract<Phase, { kind: "unlisted" }> }) {
  return (
    <div className={s.actions}>
      <span className={s.spacer} />
      <Button onClick={() => startAdd(phase.request, phase.path)}>Retry the add</Button>
      <Button variant="primary" onClick={closeAddProject}>
        Done
      </Button>
    </div>
  );
}
