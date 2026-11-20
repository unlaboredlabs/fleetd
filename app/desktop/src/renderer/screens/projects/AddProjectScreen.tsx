// New bot: a dialog over whatever is on screen (ProjectsHost mounts it; the chat, its scroll and the panel behind stay
// as they were). A name, then its repos: none, one or several, each a GitHub repo cloned onto the bot's machine or a
// folder already on it, added with + (typed, pasted, picked from what the hub found, or Browse…) and taken out with ×
// before creating. The machine, when there is more than one, at the foot. Create makes the bot and opens its chat
// behind the dialog, which then shows each repo coming in: its clone's progress, ✓, or why it failed with Retry. Esc
// closes it; a clone carries on. The agents' Mac is never offered: no bot lives there (projectHome). With several
// hubs a line beside the title says which hub it adds to, and picks another: the dialog stays as it is, in place, and
// what it lists is that hub's (NewBot, ProjectsHost.tsx, puts it in that hub's scope).

import { Dialog as D } from "radix-ui";
import { CloudDownload, Folder, Plus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Button, Select, StateGlyph, Text, Truncate, cx, underModal, type GlyphState } from "../../ui";
import { discovery as discoveryOf, orList, projectHome, repoSuggestions, target, type Discovery, type Worker } from "./discovery";
import { botAtFolder, botHolding, botName, busy, needsUpdate, ownRepo, repoKey, typedRepo, type Bot, type RepoDraft, type RepoJob } from "./create";
import { CallError, callKey } from "../../src/data/queries";
import { HubScope, useData, useDataLayer, useHub, useHubs, useToolQuery } from "../../src/data/react";
import { projectKey } from "../../src/data/store";
import { HubText } from "./HubText";
import { NAME_MAX, nameProblem } from "./model";
import { otherHost, tilde } from "./source";
import {
  addRepo,
  back,
  closeAddProject,
  create,
  dismissRepo,
  localMachine,
  pickHub,
  pickMachine,
  refuseCreate,
  removeRepo,
  retryRepo,
  setAdding,
  setName,
  setNote,
  useAddUi,
  type AddUi,
} from "./store";
import s from "./projects.module.css";

/** The dialog. Its content carries data-screen="projects.add"; the state inside, "projects.add.<state>". */
export function AddProjectScreen() {
  const ui = useAddUi();
  const hub = useHub();
  const field = useRef<HTMLInputElement>(null);
  // What each hub found, asked of every hub as it opens: Adds to then shows the other hub's machines at once.
  const [found, setFound] = useState<Readonly<Record<string, Discovery | null>>>({});
  const onFound = useCallback((at: string, d: Discovery | null) => setFound((f) => (f[at] === d ? f : { ...f, [at]: d })), []);
  const phase = ui.add.phase;
  const failures = ui.add.jobs.some((j) => j.state.t === "failed");
  const title =
    phase.kind === "form"
      ? "New bot"
      : phase.kind === "failed"
        ? `Couldn't create ${phase.title}`
        : phase.kind === "creating"
          ? `Creating ${phase.title}`
          : busy(ui.add)
            ? `Adding ${phase.bot.title}'s repos`
            : failures
              ? phase.bot.title
              : `${phase.bot.title} is ready`;

  return (
    <D.Root
      open
      onOpenChange={(open) => {
        if (!open) closeAddProject();
      }}
    >
      <D.Portal>
        <D.Overlay ref={underModal} className={s.backdrop} />
        <D.Content
          className={s.modal}
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
            {phase.kind === "form" ? <HubPick /> : null}
          </div>
          <Discoveries onFound={onFound} />
          {phase.kind === "form" ? <Form ui={ui} d={found[hub.id] ?? null} field={field} /> : phase.kind === "failed" ? <Failed message={phase.message} fix={phase.fix} /> : <Progress ui={ui} />}
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
  const machines = useData((d) => d.machines);
  return useMemo(() => {
    const name = (id: string) => machines[id]?.name ?? id;
    const homes = Object.values(machines)
      .filter(projectHome)
      .map((m) => ({ machineId: m.machineId, name: m.name, online: m.status !== "offline" }));
    if (query.data !== undefined) {
      const d = discoveryOf(query.data, name, (id) => projectHome(machines[id]));
      return d.workers.length > 0 ? d : { ...d, workers: homes };
    }
    if (query.error === null) return null;
    const e: { message: string; fix?: string | undefined } = query.error instanceof CallError ? query.error.error : { message: query.error.message };
    return { workers: homes, found: [], problems: [e.fix ? { message: e.message, fix: e.fix } : { message: e.message }] };
  }, [query.data, query.error, machines]);
};

/** Each hub's finds, each in its own hub's scope (a query keeps the client it was made with), told to `onFound`. */
function Discoveries({ onFound }: { onFound: (hub: string, d: Discovery | null) => void }) {
  const hubs = useHubs();
  return hubs.map((h) => (
    <HubScope key={h.id} hub={h}>
      <Discover onFound={onFound} />
    </HubScope>
  ));
}

function Discover({ onFound }: { onFound: (hub: string, d: Discovery | null) => void }) {
  const data = useDataLayer();
  const { id } = useHub();
  useEffect(() => {
    // New checkouts on disk raise no event: look again each time it opens.
    void data.queryClient.invalidateQueries({ queryKey: callKey("project_discover", allRepos) });
  }, [data]);
  const d = useDiscovery();
  useEffect(() => onFound(id, d), [onFound, id, d]);
  return null;
}

/**
 * With several hubs, which one the bot goes to: the hub on view, or another picked here. The dialog stays as it is
 * and the screen under it too; its machines and found repos become that hub's. With one hub, nothing.
 */
function HubPick() {
  const hubs = useHubs();
  const hub = useHub();
  if (hubs.length < 2) return null;
  const pick = (at: string) => {
    if (at !== hub.id) pickHub(at, hub.label, hubs.find((h) => h.id === at)?.label ?? at);
  };
  return (
    <div className={s.hubPick}>
      <Text size="sm" tone="quiet">
        Adds to
      </Text>
      <Select aria-label="Hub" className={s.inlineSelect} value={hub.id} options={hubs.map((h) => ({ value: h.id, label: h.label }))} onValueChange={pick} />
    </div>
  );
}

/** Why the bot can't be made on `to` as it stands (`typed`: the add field's text, which goes in too), with the fix; null when it can. */
const blocker = (to: Worker | null, d: Discovery | null, repos: ReadonlyArray<RepoDraft>, typed: string | null): string | null => {
  if (d === null) return null;
  if (to === null && d.workers.length === 0) return "Nothing runs agents yet: connect a computer, or a hosted sandbox provider in Settings › Hub › Machines.";
  if (to === null) return `Nothing is online to make it on: start fleetd on ${orList(d.workers.map((w) => w.name))}.`;
  return d.workers.some((w) => w.machineId === to.machineId) ? needsUpdate(to, repos, typed) : null;
};

function Form({ ui, d, field }: { ui: AddUi; d: Discovery | null; field: RefObject<HTMLInputElement | null> }) {
  const projects = useData((x) => x.projects);
  const to = target(d, ui.machine ?? null);
  const online = (d?.workers ?? []).filter((w) => w.online);
  const problem = nameProblem(ui.name);
  const named = botName(ui.name, ui.repos);
  const block = blocker(to, d, ui.repos, ui.adding);
  /** A folder that is a bot already: adding it would take that bot's place, so it isn't added. */
  const botAt = (path: string): string | undefined => botAtFolder(projects, to?.machineId, path)?.title;
  const go = () => {
    if (problem !== undefined) return;
    // A repo typed but not yet added goes in with the rest, or Create says why it can't.
    const typed = ui.adding === null ? null : typedRepo(ui.adding);
    if (typed !== null && "why" in typed) return refuseCreate(typed.why);
    const bot = typed?.repo.kind === "folder" ? botAt(typed.repo.path) : undefined;
    if (typed?.repo.kind === "folder" && bot !== undefined) return refuseCreate(`${tilde(typed.repo.path)} is already the bot ${bot}: open it from the sidebar.`);
    create(to?.machineId, block ?? undefined, typed?.repo);
  };
  return (
    <>
      <div className={s.field}>
        <input
          ref={field}
          className={s.input}
          spellCheck={false}
          aria-label="Name"
          placeholder={named === "" ? "Name" : named}
          maxLength={NAME_MAX + 1}
          value={ui.name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            go();
          }}
        />
      </div>
      {problem === undefined ? null : (
        <div role="alert" className={s.noteLine}>
          <Text as="p" size="sm" tone="danger">
            {problem}
          </Text>
        </div>
      )}
      <div className={s.body} data-screen={ui.repos.length === 0 ? "projects.add.empty" : "projects.add.pick"}>
        <div className={s.section}>
          <Text as="h3" size="sm" strong className={cx(s.sectionTitle)} id="new-bot-repos">
            Repos
          </Text>
          <Button variant="quiet" iconOnly aria-label="Add a repo" className={s.plus} onClick={() => setAdding(ui.adding ?? "")}>
            <Plus aria-hidden />
          </Button>
        </div>
        <ul className={s.repos} aria-labelledby="new-bot-repos">
          {ui.repos.map((r) => (
            <RepoRow key={repoKey(r)} repo={r} own={ownRepo(ui.repos) === r} onRemove={() => removeRepo(repoKey(r))} />
          ))}
        </ul>
        {ui.adding !== null ? (
          <AddRepo text={ui.adding} d={d} machineId={to?.machineId} taken={ui.repos.map(repoKey)} botAt={botAt} />
        ) : ui.repos.length === 0 ? (
          <Text as="p" size="sm" tone="quiet" className={cx(s.none)}>
            None. It works in a folder of its own.
          </Text>
        ) : null}
        {ui.note ? (
          <Text as="p" size="sm" tone={ui.note.problem ? "warning" : "quiet"} className={cx(s.none)}>
            {ui.note.text}
          </Text>
        ) : null}
      </div>
      <div className={s.foot}>
        {ui.refused || block ? (
          <div role="alert">
            <Text as="p" size="sm" tone="warning" className={cx(s.refused)}>
              {ui.refused || block}
            </Text>
          </div>
        ) : null}
        <div className={s.actions}>
          {online.length > 1 && to !== null ? (
            <>
              <Text size="sm" tone="quiet">
                On
              </Text>
              <Select aria-label="Machine" className={s.inlineSelect} value={to.machineId} options={online.map((w) => ({ value: w.machineId, label: w.name }))} onValueChange={(m) => pickMachine(m, to.machineId)} />
            </>
          ) : to !== null ? (
            <Text size="sm" tone="quiet">{`On ${to.name}`}</Text>
          ) : null}
          <span className={s.spacer} />
          <Button onClick={closeAddProject}>Cancel</Button>
          <Button variant="primary" onClick={go}>
            Create
          </Button>
        </div>
      </div>
    </>
  );
}

/** One repo listed: what it is, its name or path, and × to take it out. */
function RepoRow({ repo, own, onRemove }: { repo: RepoDraft; own: boolean; onRemove: () => void }) {
  const Icon = repo.kind === "clone" ? CloudDownload : Folder;
  const label = repo.kind === "clone" ? repo.repo : tilde(repo.path);
  return (
    <li className={s.repo} data-own={own || undefined}>
      <Icon className={s.rowIcon} aria-label={repo.kind === "clone" ? "Cloned from GitHub" : "A folder on the machine"} />
      <Truncate expand="none" as="samp" className={cx(s.name)}>
        {label}
      </Truncate>
      <span className={s.spacer} />
      <Button variant="quiet" iconOnly size="sm" aria-label={`Remove ${label}`} className={s.remove} onClick={onRemove}>
        <X aria-hidden />
      </Button>
    </li>
  );
}

/** The add field: Enter adds what is picked, Up/Down move, Esc closes it (not the dialog). */
function AddRepo({ text, d, machineId, taken, botAt }: { text: string; d: Discovery | null; machineId: string | undefined; taken: ReadonlyArray<string>; botAt: (path: string) => string | undefined }) {
  const list = useMemo(() => repoSuggestions(text, d, machineId, taken, 6), [text, d, machineId, taken]);
  const [sel, setSel] = useState<{ list: typeof list; n: number }>({ list, n: 0 });
  const selected = sel.list === list ? sel.n : 0;
  const other = otherHost(text);
  const pick = (r: RepoDraft | undefined) => {
    if (r === undefined) return;
    if (r.kind === "folder") {
      if (!r.path.startsWith("/")) return setNote({ text: "Type the folder's full path, starting with /.", problem: true });
      const bot = botAt(r.path);
      if (bot !== undefined) return setNote({ text: `${tilde(r.path)} is already the bot ${bot}: open it from the sidebar.`, problem: true });
    }
    addRepo(r.kind === "clone" ? { kind: "clone", repo: r.repo } : { kind: "folder", path: r.path.replace(/(.)\/+$/u, "$1") });
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setAdding(null);
    } else if (e.key === "ArrowDown" && list.length > 0) {
      e.preventDefault();
      setSel({ list, n: (selected + 1) % list.length });
    } else if (e.key === "ArrowUp" && list.length > 0) {
      e.preventDefault();
      setSel({ list, n: (selected - 1 + list.length) % list.length });
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(list[selected]);
    }
  };
  return (
    <div className={s.adding}>
      <div className={s.addField}>
        <input
          // A + press means typing here next.
          autoFocus
          className={s.addInput}
          spellCheck={false}
          aria-label="Repo to add"
          role="combobox"
          aria-expanded={list.length > 0}
          aria-controls="new-bot-found"
          placeholder="owner/repo, a GitHub URL, or a folder's path"
          value={text}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={onKey}
        />
        {localMachine() ? <BrowseButton machineId={machineId} /> : null}
      </div>
      {other !== null ? (
        <Text as="p" size="sm" tone="warning" className={cx(s.none)}>
          {other}
        </Text>
      ) : list.length > 0 ? (
        <div role="listbox" id="new-bot-found" aria-label="Found" className={s.found}>
          {list.map((r, i) => {
            const Icon = r.kind === "clone" ? CloudDownload : Folder;
            return (
              <div
                key={repoKey(r)}
                role="option"
                aria-selected={i === selected}
                className={s.row}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setSel({ list, n: i })}
                onClick={() => pick(r)}
              >
                <Icon className={s.rowIcon} aria-hidden />
                <Truncate expand="none" as="samp" className={cx(s.name)}>
                  {r.kind === "clone" ? r.repo : (r.path.split("/").pop() ?? r.path)}
                </Truncate>
                {r.detail ? (
                  <Truncate expand="none" size="sm" tone="quiet" className={cx(s.detail)}>
                    {r.detail}
                  </Truncate>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : d === null ? (
        <Text as="p" size="sm" tone="quiet" className={cx(s.none)}>
          Looking for repos on your machines and on GitHub…
        </Text>
      ) : (
        d.problems.map((p) => (
          <Text as="p" size="sm" tone="quiet" className={cx(s.none)} key={p.message}>
            <HubText>{p.fix ? `${p.message} ${p.fix}` : p.message}</HubText>
          </Text>
        ))
      )}
    </div>
  );
}

/** A folder on this computer: the bot goes to this computer, and folders listed for another machine come out. */
function BrowseButton({ machineId }: { machineId: string | undefined }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        void window.fleetd.projects.pickFolder().then((path) => {
          if (path === null) return;
          const local = localMachine();
          if (local) pickMachine(local.machineId, machineId);
          addRepo({ kind: "folder", path });
        });
      }}
    >
      Browse…
    </Button>
  );
}

function Failed({ message, fix }: { message: string; fix: string | undefined }) {
  return (
    <>
      <div className={s.body} data-screen="projects.add.error" role="alert">
        <Text as="p" className={cx(s.failLine)}>
          <HubText>{message}</HubText>
        </Text>
        {fix ? (
          <Text as="p" tone="quiet" className={cx(s.failLine)}>
            <HubText>{fix}</HubText>
          </Text>
        ) : null}
      </div>
      <div className={s.foot}>
        <div className={s.actions}>
          <span className={s.spacer} />
          <Button onClick={closeAddProject}>Cancel</Button>
          <Button variant="primary" onClick={back}>
            Back
          </Button>
        </div>
      </div>
    </>
  );
}

/** Made (or being made): each repo as it comes in. */
function Progress({ ui }: { ui: AddUi }) {
  const name = useData((d) => (ui.add.phase.kind === "made" ? d.machines[ui.add.phase.bot.project.machineId]?.name : undefined));
  const running = busy(ui.add);
  return (
    <>
      <div className={s.body} data-screen={running ? "projects.add.cloning" : "projects.add.ready"}>
        {ui.add.phase.kind === "made" ? (
          <Truncate size="sm" tone="quiet" className={cx(s.where)}>{`In ${tilde(ui.add.phase.bot.path)}${name ? ` on ${name}` : ""}`}</Truncate>
        ) : null}
        <ul className={s.repos} aria-label="Repos">
          {ui.add.jobs.map((j) => (
            <JobRow key={j.key} job={j} bot={ui.add.phase.kind === "made" ? ui.add.phase.bot : undefined} />
          ))}
        </ul>
      </div>
      <div className={s.foot}>
        <div className={s.actions}>
          {running ? (
            <Text size="sm" tone="quiet">
              Closing this doesn&apos;t stop it.
            </Text>
          ) : null}
          <span className={s.spacer} />
          <Button variant="primary" onClick={closeAddProject}>
            {running ? "Hide" : "Done"}
          </Button>
        </div>
      </div>
    </>
  );
}

const GLYPH: Record<RepoJob["state"]["t"], GlyphState> = { waiting: "queued", adding: "working", added: "done", failed: "failed" };
const GLYPH_WORD: Record<RepoJob["state"]["t"], string> = { waiting: "Waiting", adding: "Adding", added: "Added", failed: "Failed" };

function JobRow({ job, bot }: { job: RepoJob; bot: Bot | undefined }) {
  const label = job.draft.kind === "clone" ? job.draft.repo : tilde(job.draft.path);
  const st = job.state;
  const projects = useData((d) => d.projects);
  // The checkout in a clone's way may be a bot of its own, which adding it here archives: said before, and after.
  const holder =
    st.t === "failed" && st.existing === true && job.draft.kind === "clone" && bot !== undefined
      ? botHolding(projects, bot.project.machineId, job.draft.repo, st.at, bot.project.projectId)
      : undefined;
  const archived = st.t === "added" && st.archived !== undefined ? (projects[projectKey(st.archived)]?.title ?? st.archived.projectId) : undefined;
  return (
    <li className={s.job} data-state={st.t}>
      <div className={s.repo}>
        <span className={s.glyph}>
          <StateGlyph size="sm" state={GLYPH[st.t]} label={GLYPH_WORD[st.t]} />
        </span>
        <Truncate expand="none" as="samp" className={cx(s.name)}>
          {label}
        </Truncate>
        {st.t === "adding" || st.t === "waiting" || archived !== undefined ? (
          <Truncate expand="none" size="sm" tone="quiet" className={cx(s.detail)}>
            {st.t === "adding" ? st.detail : st.t === "waiting" ? "Waiting for the bot" : `${archived ?? ""} archived: its chat stays`}
          </Truncate>
        ) : (
          <span className={s.spacer} />
        )}
        {st.t === "failed" ? (
          <span className={s.jobActions}>
            {st.existing ? (
              <Button size="sm" onClick={() => retryRepo(job.key, true)}>
                {holder === undefined ? "Use the checkout there" : `Use it, archiving ${holder.title}`}
              </Button>
            ) : (
              <Button size="sm" onClick={() => retryRepo(job.key)}>
                Retry
              </Button>
            )}
            <Button variant="quiet" iconOnly size="sm" aria-label={`Leave out ${label}`} className={s.remove} onClick={() => dismissRepo(job.key)}>
              <X aria-hidden />
            </Button>
          </span>
        ) : null}
      </div>
      {st.t === "adding" && st.fraction !== undefined ? (
        <div className={s.bar} role="progressbar" aria-label={`Cloning ${label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(st.fraction * 100)}>
          <div className={s.barFill} style={{ transform: `scaleX(${Math.min(Math.max(st.fraction, 0), 1)})` }} />
        </div>
      ) : null}
      {st.t === "failed" ? (
        <Text as="p" size="sm" tone="quiet" className={cx(s.why)}>
          <HubText>{st.fix ? `${st.message} ${st.fix}` : st.message}</HubText>
          {holder === undefined ? null : ` It is the bot ${holder.title}: using it here archives ${holder.title}, whose chat stays but whose lead stops.`}
        </Text>
      ) : null}
    </li>
  );
}
