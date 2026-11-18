// Get started's view from the team's own state (model.ts says what each step waits on): the hub's machines and
// whether their claude is logged in, the person's GitHub and the App's installations (github_app_get), the team's
// bots, the repositories the App reaches (the cloud's GITHUB_REPOS_PATH), New bot's flow while it makes one. The two
// things only this browser knows, a skipped GitHub and Skip for now, are kept in its storage per team. Shown only on a
// fleetd cloud team in the web app; the self-hosted hub and the desktop keep their own first run (setup/FirstRun).
import { useEffect, useMemo, useRef, useState } from "react";
import type { MachineJoinOutput } from "../../../shared/contracts";
import type { CloudRepo } from "../../../shared/cloud";
import { useData, useHub, useToolQuery } from "../../src/data/react";
import { selectShownProjects } from "../../src/data/selectors";
import { onWeb } from "../../src/web";
import { useHubRole } from "../admin/role";
import { MACHINE_WAIT_MS } from "../admin/machines";
import { openAddProject, startBot, type AddUi } from "../projects/store";
import { errorText, useHubCall, useRefetch } from "../settings/hub";
import { navigate } from "../shell/navigation";
import { toHash } from "../shell/routes";
import {
  claudeLoggedOut,
  githubReturnOf,
  projectLine,
  pushedWords,
  stepsLeft,
  withoutGithubReturn,
  type ComputerStep,
  type GithubReturn,
  type GithubStep,
  type ProjectStep,
  type StartView,
} from "./model";
import { startScreen, useKept, writeKept } from "./kept";
import type { StartActions } from "./StartPage";

const noInput = {};

/** GitHub's trip, once read from the address it came back to (read once per page: the address is cleaned at once). */
let returned: GithubReturn | null | undefined;
const takeReturn = (): GithubReturn | null => {
  if (returned !== undefined) return returned;
  returned = githubReturnOf(window.location.search);
  if (returned !== null) window.history.replaceState(window.history.state, "", `${window.location.pathname}${withoutGithubReturn(window.location.search)}${window.location.hash}`);
  return returned;
};

/** For tests: read the address again. */
export const resetReturn = (): void => {
  returned = undefined;
};

type Login =
  | {
      readonly machineId: string;
      readonly login: "starting" | "code" | "checking";
      readonly url?: string;
      readonly opened?: boolean;
      readonly error?: string;
    }
  | {
      readonly machineId: string;
      readonly login: "start";
      readonly error?: string;
    };

/**
 * The page's view and what its controls do, or null until the hub has said enough to tell. `page`: the page itself is
 * on show, which makes a join line and reads the repositories; the You menu's row asks without them. `add`: New bot's
 * state (projects/store), while the page waits on the bot it started.
 */
export function useStart(
  page: boolean,
  add?: AddUi,
): {
  readonly view: StartView | null;
  readonly actions: StartActions;
  readonly later: boolean;
} {
  const hub = useHub();
  const role = useHubRole();
  const call = useHubCall();
  const refetch = useRefetch();
  const live = useData((d) => d.fresh);
  const machines = useData((d) => d.machines);
  const projects = useData((d) => d.projects);
  // Whether each bot's agents are at work, once the hub's work is read; a bot is listed before that.
  const rows = useData(selectShownProjects);
  const kept = useKept(hub.id);
  const cloudTeam = hub.cloud === true && onWeb();
  const github = useToolQuery("github_app_get", noInput, {
    enabled: cloudTeam,
  });
  const [now] = useState(() => Date.now());

  const bots = useMemo(() => {
    const work = new Map((rows ?? []).map((r) => [r.key, r]));
    return Object.entries(projects)
      .filter(([, p]) => p.archivedAt === undefined)
      .map(([key, project]) => ({
        key,
        project,
        running: work.get(key)?.running ?? 0,
        working: work.get(key)?.working ?? false,
      }))
      .sort((a, b) => a.project.title.localeCompare(b.project.title) || a.key.localeCompare(b.key));
  }, [projects, rows]);
  const teammate = hub.invited === true || !role.administers || bots.length > 0;
  const listed = Object.values(machines).filter((m) => m.agentsMac !== true);

  // GitHub's trip comes back to this page with what it ended on.
  const [back] = useState(() => (page ? takeReturn() : null));
  useEffect(() => {
    if (back === null) return;
    if (back.at === "requested") writeKept(hub.id, { github: "requested" });
    else if (back.at !== "failed") writeKept(hub.id, { github: null });
    refetch(["github_app_get"]);
  }, [back, hub.id, refetch]);

  // The join line, made while no computer has joined, and again each time its code runs out.
  const owner = cloudTeam && !teammate && !role.pending;
  const wantLine = page && owner && live && listed.length === 0;
  const [join, setJoin] = useState<{
    readonly out: MachineJoinOutput | null;
    readonly error?: string;
  }>({ out: null });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!wantLine) return undefined;
    let timer: number | undefined;
    const make = () => {
      call("machine_join", {}).then(
        (out) => {
          if (!mounted.current) return;
          setJoin({ out });
          // The next line a few seconds before this one's code runs out, so the one on show always works.
          const wait = Math.max(5_000, Date.parse(out.expiresAt) - Date.now() - 5_000);
          timer = window.setTimeout(make, wait);
        },
        (e: unknown) => mounted.current && setJoin({ out: null, error: errorText(e) }),
      );
    };
    make();
    return () => window.clearTimeout(timer);
  }, [wantLine, call]);

  // Claude's login on the machine that joined: Log in, its page, the code.
  const [login, setLogin] = useState<Login | null>(null);
  const [loggedIn, setLoggedIn] = useState<ReadonlySet<string>>(() => new Set());
  const loggedOut = listed.find((m) => claudeLoggedOut(m) && !loggedIn.has(m.machineId));
  // Joined, but degraded for another reason than Claude's login (claude not installed, say): the hub says why and how.
  const unusable = listed.find((m) => m.status === "degraded" && !claudeLoggedOut(m) && !loggedIn.has(m.machineId));
  const ready = listed.find((m) => m.status === "online" && !claudeLoggedOut(m)) ?? listed.find((m) => loggedIn.has(m.machineId)) ?? listed.find((m) => m.status !== "degraded") ?? null;

  const computer: ComputerStep =
    ready !== null
      ? { at: "ready", machine: ready.name }
      : loggedOut !== undefined
        ? {
            at: "claude",
            machine: loggedOut.name,
            login: login?.machineId === loggedOut.machineId ? login.login : "start",
            ...(login?.machineId === loggedOut.machineId && login.login !== "start" && login.url !== undefined ? { url: login.url } : {}),
            ...(login?.machineId === loggedOut.machineId && login.login !== "start" && login.opened === false ? { opened: false } : {}),
            ...(login?.machineId === loggedOut.machineId && login.error !== undefined ? { error: login.error } : {}),
          }
        : unusable !== undefined
          ? { at: "unusable", machine: unusable.name, reason: unusable.degradedReason ?? `Agents can't run on ${unusable.name} yet.` }
          : {
            at: "line",
            line: join.out?.line ?? null,
            ...(join.error === undefined ? {} : { error: join.error }),
          };

  // GitHub: the person's own connection, and for an owner the App installed on the team.
  const [githubBusy, setGithubBusy] = useState<string | null | true>(null);
  const me = github.data?.me;
  const connected = me !== undefined && me.lapsed !== true;
  const installed = (github.data?.app?.installations?.length ?? 0) > 0;
  const githubError = typeof githubBusy === "string" ? githubBusy : back?.at === "failed" ? back.why : undefined;
  const githubStep: GithubStep =
    githubBusy === true
      ? { at: "waiting" }
      : connected && (teammate || installed)
        ? { at: "done", login: me.login }
        : kept.github !== undefined
          ? { at: kept.github }
          : {
              at: "todo",
              ...(githubError === undefined ? {} : { error: githubError }),
            };

  // The repositories, once there is something to read them with.
  const wantRepos = page && owner && githubStep.at === "done";
  const [repos, setRepos] = useState<{
    readonly list: readonly CloudRepo[] | null;
    readonly problem?: string;
    readonly none?: true;
  }>({ list: null });
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (!wantRepos) return;
    void window.fleetd.cloud.githubRepos(hub.id).then((out) => {
      if (!mounted.current) return;
      if (out.ok) setRepos({ list: out.repos });
      else setRepos(out.none === true ? { list: [], none: true } : { list: [], problem: out.failure.message });
    });
  }, [wantRepos, hub.id]);

  // The bot New bot is making from a pick here, until the hub lists it and its chat opens.
  const creating = add?.add.phase.kind === "creating" ? add.add.phase : null;
  const project: ProjectStep =
    bots[0] !== undefined
      ? { at: "made", name: bots[0].project.title }
      : creating !== null && ready !== null
        ? { at: "adding", what: creating.title, machine: ready.name }
        : {
            at: "pick",
            repos: (repos.list ?? []).map((r) => ({
              owner: r.owner,
              name: r.name,
              pushed: r.pushedAt === undefined ? "" : pushedWords(r.pushedAt, now),
            })),
            query,
            ...(wantRepos && repos.list === null ? { loading: true } : {}),
            ...(repos.problem === undefined ? {} : { problem: repos.problem }),
            ...(repos.none === true || (repos.list !== null && repos.list.length === 0 && repos.problem === undefined) ? { none: true as const } : {}),
          };

  const known = cloudTeam && live && !role.pending && (github.data !== undefined || github.error !== null);
  const view: StartView | null = !known
    ? null
    : teammate
      ? {
          who: "teammate",
          team: hub.label,
          github: githubStep,
          projects: bots.map((r) => ({
            key: r.key,
            name: r.project.title,
            busy: r.working,
            line: projectLine(r.running, r.working, r.project.lastActivityAt, now),
          })),
        }
      : {
          who: "owner",
          team: hub.label,
          computer,
          github: githubStep,
          project,
        };

  const startLogin = () => {
    if (loggedOut === undefined) return;
    const machineId = loggedOut.machineId;
    // The page that opened: opened again from the click itself, which no browser blocks.
    if (login?.machineId === machineId && login.login === "code" && login.url !== undefined) {
      const { url } = login;
      void window.fleetd.openExternal(url).then((o) => o.ok && setLogin({ machineId, login: "code", url }));
      return;
    }
    setLogin({ machineId, login: "starting" });
    call("machine_claude_login", { machineId }, { timeoutMs: MACHINE_WAIT_MS }).then(
      (out) => {
        if (out.loginUrl === undefined) {
          setLoggedIn((was) => new Set([...was, machineId]));
          setLogin(null);
          return;
        }
        const url = out.loginUrl;
        setLogin({ machineId, login: "code", url });
        // Opened after the machine's answer, outside the click: a browser may block it, and then the page says so.
        void window.fleetd.openExternal(url).then(
          (o) => !o.ok && setLogin((was) => (was?.machineId === machineId && was.login === "code" ? { machineId, login: "code", url, opened: false } : was)),
          () => setLogin((was) => (was?.machineId === machineId && was.login === "code" ? { machineId, login: "code", url, opened: false } : was)),
        );
      },
      (e: unknown) => setLogin({ machineId, login: "start", error: errorText(e) }),
    );
  };

  /** GitHub's trip, from this tab; `install`: its install page again, to choose more repositories. */
  const goGithub = (install: boolean) => {
    setGithubBusy(true);
    writeKept(hub.id, { github: null });
    const backTo = `${window.location.pathname}${toHash(startScreen(hub.id))}`;
    void window.fleetd.cloud.connectGithub(hub.id, { back: backTo, ...(install ? { install } : {}) }).then((out) => {
      if (out.ok) return;
      setGithubBusy(out.connected === true ? null : out.failure.fix === undefined ? out.failure.message : `${out.failure.message} ${out.failure.fix}`);
      if (out.connected === true) refetch(["github_app_get"]);
    });
  };

  const actions: StartActions = {
    onClaudeLogin: startLogin,
    onClaudeCode: (code) => {
      if (loggedOut === undefined || login === null || login.login !== "code" || code.trim() === "") return;
      const { machineId, url } = login;
      setLogin({
        machineId,
        login: "checking",
        ...(url === undefined ? {} : { url }),
      });
      call("machine_claude_login", { machineId, code: code.trim() }, { timeoutMs: MACHINE_WAIT_MS }).then(
        () => {
          setLoggedIn((was) => new Set([...was, machineId]));
          setLogin(null);
        },
        // A used or wrong code is spent: the login starts again.
        (e: unknown) => setLogin({ machineId, login: "start", error: errorText(e) }),
      );
    },
    onGithub: () => goGithub(false),
    onGithubRepos: () => goGithub(true),
    onGithubSkip: () => writeKept(hub.id, { github: "skipped" }),
    onQuery: setQuery,
    onRepo: (owner, name) => {
      if (ready !== null)
        startBot(ready.machineId, {
          kind: "clone",
          repo: `${owner}/${name}`,
        });
    },
    onEmpty: () => openAddProject(ready === null ? undefined : { text: "", machine: ready.machineId }),
    onOpen: (key) => {
      const at = key.indexOf("/");
      navigate({
        id: "project",
        project: { machineId: key.slice(0, at), projectId: key.slice(at + 1) },
        message: null,
        at: hub.id,
      });
    },
    onSkip: () => {
      writeKept(hub.id, { later: true });
      navigate({ id: "home", at: hub.id });
    },
  };
  return { view, actions, later: kept.later === true };
}

/** Get started's steps left for the You menu's quiet row: 0 anywhere but a fleetd cloud team in the web app. */
export const useStartLeft = (): number => {
  const { view } = useStart(false);
  return view === null ? 0 : stepsLeft(view);
};
