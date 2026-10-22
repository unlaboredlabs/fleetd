// "Add project…" (#/projects/add): one sheet that clones a GitHub repo onto a worker or adds a folder already on
// one. One field (paste a URL, type a path, or filter), the repos the hub found, the machine it goes to; then the
// clone's progress, the ready state with what the lead will need, or the error and its fix. Up/Down pick, Enter
// adds, Esc closes (a clone carries on).

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button, Dot, Input, Sheet, Text, Truncate, copyText, cx } from "../../ui";
import { clonePath, discovery as discoveryOf, orList, plan, rows as rowsFor, target, type Discovery, type Failure, type Found, type Plan, type Ready, type Request, type Row, type Worker } from "./discovery";
import { CallError, callKey } from "../../src/data/queries";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import type { Job } from "./flow";
import { HubText } from "./HubText";
import { otherHost, tilde } from "./source";
import {
  addAnother,
  back,
  closeAddProject,
  localMachine,
  openProject,
  pickMachine,
  setText,
  sheetHidden,
  sheetShown,
  startAdd,
  useAddUi,
  type Note,
} from "./store";
import s from "./projects.module.css";

/** The add screen. Its root carries data-screen="projects.add"; the state inside, "projects.add.<state>". */
export function AddProjectScreen() {
  const pick = usePick();
  const phase = pick.ui.add.phase;
  const data = useDataLayer();
  useEffect(() => {
    sheetShown();
    // New checkouts on disk raise no event: look again each time the sheet opens.
    void data.queryClient.invalidateQueries({ queryKey: callKey("project_discover", allRepos) });
    return sheetHidden;
  }, [data]);

  const title =
    phase.kind === "working" ? `Adding ${phase.job.what}` : phase.kind === "ready" ? `${phase.ready.title} is ready` : phase.kind === "failed" ? `Couldn't add ${phase.what}` : "Add a project";

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) closeAddProject();
      }}
      title={title}
      footer={phase.kind === "pick" ? <PickFooter pick={pick} /> : phase.kind === "ready" ? <ReadyFooter ready={phase.ready} /> : phase.kind === "failed" ? <FailedFooter failure={phase.failure} /> : <WorkingFooter />}
    >
      <div className={s.root} data-screen="projects.add">
        {phase.kind === "pick" ? <Pick pick={pick} /> : null}
        {phase.kind === "working" ? <Working job={phase.job} /> : null}
        {phase.kind === "ready" ? <ReadyView ready={phase.ready} /> : null}
        {phase.kind === "failed" ? <FailedView failure={phase.failure} /> : null}
      </div>
    </Sheet>
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
    if (query.data !== undefined) {
      const d = discoveryOf(query.data, name);
      if (d.workers.length > 0) return d;
      return { ...d, workers: Object.values(machines).map((m) => ({ machineId: m.machineId, name: m.name, online: m.status !== "offline" })) };
    }
    if (query.error === null) return null;
    const e: { message: string; fix?: string | undefined } = query.error instanceof CallError ? query.error.error : { message: query.error.message };
    return {
      workers: Object.values(machines).map((m) => ({ machineId: m.machineId, name: m.name, online: m.status !== "offline" })),
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

const requestFor = (p: Plan, to: Worker | null): { request: Request; path: string } | null => {
  switch (p.kind) {
    case "clone":
      return to ? { request: { kind: "clone", repo: p.repo, machineId: to.machineId, useExisting: false }, path: clonePath(to, p.repo) ?? "" } : null;
    case "folder":
      return { request: { kind: "folder", machineId: p.machineId, path: p.path }, path: p.path };
    default:
      return null;
  }
};

const submit = (p: Plan, to: Worker | null) => {
  if (p.kind === "open") {
    openProject(p.project.machineId, p.project.projectId);
    return;
  }
  // A typed path must be absolute on the machine: ~ and ./ mean nothing to the hub.
  if (p.kind === "folder" && !p.path.startsWith("/")) return;
  const r = requestFor(p, to);
  if (r) startAdd(r.request, r.path);
};

function Pick({ pick }: { pick: PickData }) {
  const { ui, d, rows, selected, select, to, planFor } = pick;
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
      submit(planFor(rows[selected]), to);
    }
  };

  return (
    <>
      <Input
        autoFocus
        aria-label="GitHub URL, folder path, or filter"
        placeholder="Paste a GitHub URL, type a folder's path, or filter the list"
        value={ui.text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
      />
      {ui.note ? <NoteLine note={ui.note} /> : null}
      <div data-screen={d === null ? "projects.add.loading" : rows.length === 0 && ui.text.trim() === "" ? "projects.add.empty" : "projects.add.pick"}>
        {d === null ? (
          <Text tone="quiet" className={cx(s.note)}>
            Looking for repos on your machines and on GitHub…
          </Text>
        ) : (
          <List d={d} rows={rows} selected={selected} select={select} text={ui.text} to={to} planFor={planFor} />
        )}
      </div>
    </>
  );
}

function NoteLine({ note }: { note: Note }) {
  return (
    <Text size="sm" tone={note.problem ? "warning" : "quiet"} className={cx(s.note)}>
      {note.text}
    </Text>
  );
}

const groupOf = (r: Row, found: ReadonlyArray<Found>, name: (id: string) => string): string => {
  if (r.kind === "clone") return "Paste";
  if (r.kind === "folder") return "Folder";
  const f = found[r.index];
  return f?.source.kind === "checkout" ? `On ${name(f.source.machineId)}` : "GitHub";
};

function List(props: {
  d: Discovery;
  rows: ReadonlyArray<Row>;
  selected: number;
  select: (n: number) => void;
  text: string;
  to: Worker | null;
  planFor: (r: Row) => Plan;
}) {
  const { d, rows, selected, select, text, to, planFor } = props;
  const name = (id: string) => d.workers.find((w) => w.machineId === id)?.name ?? id;
  if (rows.length === 0) {
    const hint = otherHost(text);
    if (hint) return <Text tone="warning" className={cx(s.note)}>{hint}</Text>;
    if (text.trim() !== "") {
      return (
        <Text tone="quiet" className={cx(s.note)}>
          Nothing matches. Paste a GitHub URL, or type a folder's full path on one of your machines.
        </Text>
      );
    }
    return <Empty d={d} />;
  }
  return (
    <>
      <div className={s.list} role="listbox" aria-label="Repos">
        {rows.map((r, i) => {
          const group = groupOf(r, d.found, name);
          const first = i === 0 || groupOf(rows[i - 1] as Row, d.found, name) !== group;
          return (
            <div key={rowKey(r, d.found)}>
              {first ? (
                <Text as="div" size="xs" tone="quiet" strong className={cx(s.group)}>
                  {group}
                </Text>
              ) : null}
              <RowView row={r} d={d} planFor={planFor} selected={i === selected} onPick={() => select(i)} onGo={() => submit(planFor(r), to)} />
            </div>
          );
        })}
      </div>
      <Problems d={d} />
    </>
  );
}

const rowKey = (r: Row, found: ReadonlyArray<Found>): string => {
  if (r.kind !== "found") return `${r.kind}:${r.kind === "clone" ? r.repo : r.path}`;
  const f = found[r.index];
  return f?.source.kind === "checkout" ? `co:${f.source.machineId}:${f.source.path}` : `gh:${f?.name ?? r.index}`;
};

function RowView(props: { row: Row; d: Discovery; planFor: (r: Row) => Plan; selected: boolean; onPick: () => void; onGo: () => void }) {
  const { row, d } = props;
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (props.selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [props.selected]);
  let title: string;
  let sub = "";
  let mono = false;
  let side = "";
  let added = false;
  if (row.kind === "clone") {
    title = `Clone ${row.repo}`;
    sub = "from GitHub";
  } else if (row.kind === "folder") {
    title = row.path;
    mono = true;
    const p = props.planFor(row);
    const on = p.kind === "folder" ? (d.workers.find((w) => w.machineId === p.machineId)?.name ?? p.machineId) : null;
    sub = on === null ? "no machine is online" : `a folder on ${on}`;
  } else {
    const f = d.found[row.index];
    title = f?.name ?? "";
    if (f?.source.kind === "checkout") {
      sub = tilde(f.source.path);
      mono = true;
    } else if (f?.private) sub = "private";
    side = f?.detail ?? "";
    added = f?.project !== undefined;
  }
  return (
    <button
      ref={ref}
      type="button"
      role="option"
      aria-selected={props.selected}
      className={s.row}
      onClick={props.onPick}
      onDoubleClick={props.onGo}
    >
      {/* Repo and folder names are the names on disk and on GitHub, shown as they are (samp: machine text). */}
      <span className={s.rowMain}>
        <Truncate expand="none" as="samp" className={cx(s.name)}>
          {title}
        </Truncate>
        {sub ? (
          <Truncate expand="none" size="sm" tone="quiet" mono={mono} {...(mono ? { as: "samp" } : {})}>
            {sub}
          </Truncate>
        ) : null}
      </span>
      <span className={s.rowSide}>
        {side ? (
          <Truncate expand="none" size="xs" tone="quiet">
            {side}
          </Truncate>
        ) : null}
        {added ? <span className={s.tag}>Added</span> : null}
      </span>
    </button>
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
  const local = localMachine();
  // gh's own trouble, when the hub reports one, is listed below with its fix.
  const gh =
    d.ghOn !== undefined
      ? `gh on ${d.ghOn} listed nothing for you or your orgs.`
      : d.problems.length === 0
        ? "GitHub repos aren't listed: gh isn't logged in on the hub or a machine (run gh auth login there)."
        : "";
  return (
    <div className={s.empty}>
      <Text strong>No repos found on {orList(d.workers.map((w) => w.name))}.</Text>
      <Text tone="quiet">Looked for git checkouts in ~/src, ~/code, ~/projects and ~/dev, two folders deep. {gh}</Text>
      <Text tone="quiet">
        {local
          ? "Paste a GitHub URL above, type a folder's full path, or Browse… for a folder on this computer."
          : "Paste a GitHub URL above, or type a folder's full path on one of your machines."}
      </Text>
      <Problems d={d} />
    </div>
  );
}

function MachinePicker({ workers, chosen, best }: { workers: ReadonlyArray<Worker>; chosen: string | undefined; best: string | undefined }) {
  return (
    <div className={s.machines} role="group" aria-label="Machine">
      {workers.map((w) => (
        <Button
          key={w.machineId}
          className={s.machine}
          aria-pressed={chosen === w.machineId}
          disabled={!w.online}
          onClick={() => pickMachine(w.machineId)}
          title={w.online ? undefined : `${w.name} is offline`}
        >
          {w.online ? (best === w.machineId ? `${w.name} · suggested` : w.name) : `${w.name} · offline`}
        </Button>
      ))}
    </div>
  );
}

function PickFooter({ pick }: { pick: PickData }) {
  const { d, rows, selected, to, planFor } = pick;
  const p = planFor(rows[selected]);
  const local = localMachine();
  const workers = d?.workers ?? [];
  let where = "";
  let note = "";
  let label = "Add project";
  let enabled = d !== null;
  let picker = false;
  const nameOf = (id: string) => workers.find((w) => w.machineId === id)?.name ?? id;
  switch (p.kind) {
    case "clone": {
      label = "Clone and add";
      picker = true;
      if (to) {
        const path = clonePath(to, p.repo);
        if (path) where = `${tilde(path)} on ${to.name}`;
        else note = `Into its clone folder on ${to.name}.`;
      } else {
        note = "No machine is online to clone onto.";
        enabled = false;
      }
      break;
    }
    case "folder":
      if (p.fixed) {
        where = `${tilde(p.path)} on ${nameOf(p.machineId)}`;
        note = "Added as it is: nothing is cloned.";
      } else {
        picker = true;
        enabled = p.path.startsWith("/");
        if (enabled) where = `${p.path} on ${nameOf(p.machineId)}`;
        else note = "Type the full path, starting with /.";
      }
      break;
    case "open":
      label = "Open project";
      note = `Already a project on ${nameOf(p.project.machineId)}.`;
      break;
    case "nothing":
      enabled = false;
      break;
  }
  return (
    <div className={s.footer}>
      {picker && workers.length > 0 ? <MachinePicker workers={workers} chosen={p.kind === "folder" ? p.machineId : to?.machineId} best={d?.best} /> : null}
      {note ? (
        <Text size="sm" tone="quiet">
          {note}
        </Text>
      ) : null}
      <div className={s.actions}>
        <span className={s.where}>
          {where ? (
            <Truncate size="sm" tone="quiet" mono as="samp">
              {where}
            </Truncate>
          ) : null}
        </span>
        {local ? <BrowseButton /> : null}
        <Button variant="primary" disabled={!enabled} onClick={() => submit(p, to)}>
          {label}
        </Button>
      </div>
    </div>
  );
}

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
        {STEPS.filter(([step]) => job.clone || step !== "clone").map(([step, label, idle]) => {
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
      <Text size="sm" tone="quiet">
        Hide this and carry on; the add keeps going, and a note says when it's ready.
      </Text>
    </div>
  );
}

function WorkingFooter() {
  return <Button onClick={closeAddProject}>Hide</Button>;
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
    <div className={s.footer}>
      <Text size="sm" tone="quiet">
        Open its chat and tell the lead what you want.
      </Text>
      <div className={s.actions}>
        <Button onClick={addAnother}>Add another</Button>
        <Button variant="primary" onClick={() => openProject(ready.project.machineId, ready.project.projectId)}>
          Open chat
        </Button>
      </div>
    </div>
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
    <>
      <Button onClick={back}>Back</Button>
      {a ? (
        <Button
          variant="primary"
          onClick={() => {
            if (a.kind === "open") openProject(a.project.machineId, a.project.projectId);
            else startAdd(a.request, a.request.kind === "folder" ? a.request.path : "");
          }}
        >
          {a.kind === "use_existing" ? "Add the existing folder" : a.kind === "retry" ? "Send it again" : "Open project"}
        </Button>
      ) : null}
    </>
  );
}
