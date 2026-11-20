// Get started's view from the team's own state (model.ts says what each step waits on): the hub's machines and
// whether their claude is logged in, the hub's Tailscale device (tailnet_get) and its Claude API key
// (claude_accounts_get), the person's GitHub and the App's installations (github_app_get), the team's
// bots, the repositories the App reaches (the cloud's GITHUB_REPOS_PATH), New bot's flow while it makes one. The two
// things only this browser knows, a skipped GitHub or Tailscale and Skip for now, are kept in its storage per team. Shown only on a
// fleetd cloud team in the web app; the self-hosted hub and the desktop keep their own first run (setup/FirstRun).
import { useEffect, useMemo, useRef, useState } from "react";
import type { ClaudeAccountRequest } from "../../../shared/ipc";
import type { MachineJoinOutput } from "../../../shared/contracts";
import type { CloudRepo } from "../../../shared/cloud";
import { CallError } from "../../src/data/queries";
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
  projectLine,
  pushedWords,
  stepsLeft,
  type ClaudeStep,
  type ComputerStep,
  type GithubStep,
  type KeyState,
  type ProjectStep,
  type StartView,
  type TailscaleStep,
} from "./model";
import { startScreen, takeGithubReturn, useKept, writeKept } from "./kept";
import type { StartActions } from "./StartPage";
import { specOf } from "../../../shared/providers";
import { hostedProblem, runnerNeedsClaude, useWaitedOut } from "../setup/hostedWait";

const noInput = {};

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
  // The team's computers: neither the agents' Mac nor the hub's runner for hosted sandboxes, which is none.
  const listed = Object.values(machines).filter((m) => m.agentsMac !== true && m.runner !== true);
  const runnerMachine = Object.values(machines).find((m) => m.runner === true);

  // GitHub's trip comes back to this page with what it ended on.
  const [back] = useState(() => (page ? takeGithubReturn() : null));
  useEffect(() => {
    if (back === null) return;
    if (back.at === "requested") writeKept(hub.id, { github: "requested" });
    else if (back.at !== "failed") writeKept(hub.id, { github: null });
    refetch(["github_app_get"]);
  }, [back, hub.id, refetch]);

  // The join line, made while no computer has joined, and again each time its code runs out.
  const owner = cloudTeam && !teammate && !role.pending;
  // Where agents run can also be a hosted provider on the team's own key: its connection and last check.
  const sandboxes = useToolQuery("sandbox_get", noInput, { enabled: owner && live });
  const hosted = sandboxes.data?.providers.find((p) => p.connected && p.check?.ok === true);
  const wantLine = page && owner && live && listed.length === 0 && hosted === undefined;
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
    // Off once the computer joins (or the page goes): a line still being made then makes no next one.
    let stopped = false;
    const make = () => {
      call("machine_join", {}).then(
        (out) => {
          if (stopped || !mounted.current) return;
          setJoin({ out });
          // The next line a few seconds before this one's code runs out, so the one on show always works.
          const wait = Math.max(5_000, Date.parse(out.expiresAt) - Date.now() - 5_000);
          timer = window.setTimeout(make, wait);
        },
        (e: unknown) => !stopped && mounted.current && setJoin({ out: null, error: errorText(e) }),
      );
    };
    make();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [wantLine, call]);

  // Claude's login on the machine that joined: Log in, its page, the code.
  const [login, setLogin] = useState<Login | null>(null);
  const [loggedIn, setLoggedIn] = useState<ReadonlySet<string>>(() => new Set());
  const loggedOut = listed.find((m) => claudeLoggedOut(m) && !loggedIn.has(m.machineId));
  // Joined, but degraded for another reason than Claude's login (claude not installed, say): the hub says why and how.
  const unusable = listed.find((m) => m.status === "degraded" && !claudeLoggedOut(m) && !loggedIn.has(m.machineId));
  const ready = listed.find((m) => m.status === "online" && !claudeLoggedOut(m)) ?? listed.find((m) => loggedIn.has(m.machineId) && m.status !== "offline") ?? null;
  // Joined before, and off now: agents can't run there until it's back.
  const offline = listed.find((m) => m.status === "offline");
  // The computer agents run on: ready, or joined with its claude logged out (the hub's key may reach it).
  const joined = ready ?? loggedOut ?? null;

  const providerName = hosted === undefined ? "" : specOf(hosted.provider).name;
  // The hosted sandboxes wait on a Claude account (the hub's runner says so): the Claude step's, not this one's.
  const needsClaude = runnerNeedsClaude(runnerMachine);
  const hostedWaits = ready === null && hosted !== undefined && listed.length === 0 && runnerMachine?.status !== "online" && !needsClaude;
  // Not ready within the wait: why, its fix, and Try again (the provider's key tested again).
  const hostedWait = useWaitedOut(owner && hostedWaits);
  const [hostedTrying, setHostedTrying] = useState(false);
  const [hostedTried, setHostedTried] = useState<string | null>(null);
  const hostedFailed = hostedWait.over && hosted !== undefined ? hostedProblem(hosted.provider, hosted.check, runnerMachine) : undefined;
  const computer: ComputerStep =
    ready !== null
      ? { at: "ready", machine: ready.name }
      : hosted !== undefined && listed.length === 0
        ? !hostedWaits
          ? { at: "hosted", provider: providerName }
          : hostedFailed !== undefined
            ? { at: "hosted_failed", provider: providerName, reason: hostedFailed.reason, fix: hostedTried ?? hostedFailed.fix, ...(hostedTrying ? { trying: true } : {}) }
            : { at: "hosted_wait", provider: providerName }
        : loggedOut !== undefined
          ? { at: "ready", machine: loggedOut.name }
          : unusable !== undefined
            ? { at: "unusable", machine: unusable.name, reason: unusable.degradedReason ?? `Agents can't run on ${unusable.name} yet.` }
            : offline !== undefined
              ? { at: "offline", machine: offline.name }
              : {
                  at: "line",
                  line: join.out?.line ?? null,
                  ...(join.error === undefined ? {} : { error: join.error }),
                };

  // Tailscale: the hub's one device, on a hub that runs it. Read here rather than
  // through Settings' row (settings/Tailscale.tsx), which the You menu's first load would then carry.
  const tailnetRead = useToolQuery("tailnet_get", noInput, { enabled: owner && live });
  const tailnetState = tailnetRead.data;
  const [tailnetBusy, setTailnetBusy] = useState(false);
  const [tailnetProblem, setTailnetProblem] = useState<string | null>(null);
  // The person signs in on Tailscale's page: the hub's state is read again until it isn't waiting on them.
  const tailnetWaits = tailnetState?.status === "login" || tailnetState?.status === "approve" || tailnetState?.status === "starting";
  useEffect(() => {
    if (!tailnetWaits) return undefined;
    const timer = window.setInterval(() => refetch(["tailnet_get"]), 2_000);
    return () => window.clearInterval(timer);
  }, [tailnetWaits, refetch]);
  const tailscale: TailscaleStep | undefined =
    tailnetState === undefined || (tailnetState.status === "off" && tailnetState.problem !== undefined)
      ? undefined
      : tailnetState.status === "connected"
        ? { at: "done", tailnet: tailnetState.tailnet ?? "Connected" }
        : // Skipped stays skipped, a sign-in left half way included; Connect again clears it.
          kept.tailscale === "skipped"
          ? { at: "skipped" }
          : tailnetState.status === "login" || tailnetState.status === "starting"
            ? { at: "signin", ...(tailnetState.loginUrl === undefined ? {} : { url: tailnetState.loginUrl }) }
            : tailnetState.status === "approve"
              ? { at: "approve" }
              : {
                  at: "todo",
                  ...(tailnetBusy ? { busy: true } : {}),
                  ...(tailnetProblem !== null ? { error: tailnetProblem } : tailnetState.status === "failed" && tailnetState.problem !== undefined ? { error: tailnetState.problem } : {}),
                };

  // Claude: the hub's API key (with its endpoint) reaches every place; else each place's own way in.
  const accounts = useToolQuery("claude_accounts_get", noInput, { enabled: owner && live });
  const [keyState, setKeyState] = useState<KeyState | undefined>(undefined);
  const withKey = keyState === undefined ? {} : { key: keyState };
  const claude: ClaudeStep =
    accounts.data?.hubApi !== undefined
      ? { at: "done", what: "API key" }
      : ready !== null
        ? { at: "done", what: ready.name }
        : computer.at === "hosted" && runnerMachine?.status === "online"
          ? { at: "done", what: providerName }
          : loggedOut !== undefined && computer.at === "ready"
            ? {
                at: "login",
                machine: loggedOut.name,
                login: login?.machineId === loggedOut.machineId ? login.login : "start",
                ...(login?.machineId === loggedOut.machineId && login.login !== "start" && login.url !== undefined ? { url: login.url } : {}),
                ...(login?.machineId === loggedOut.machineId && login.login !== "start" && login.opened === false ? { opened: false } : {}),
                ...(login?.machineId === loggedOut.machineId && login.error !== undefined ? { error: login.error } : {}),
                ...withKey,
              }
            : computer.at === "hosted"
              ? { at: "account", provider: providerName, ...withKey }
              : { at: "wait" };

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
    readonly truncated?: true;
  }>({ list: null });
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (!wantRepos) return;
    void window.fleetd.cloud.githubRepos(hub.id).then((out) => {
      if (!mounted.current) return;
      if (out.ok) setRepos({ list: out.repos, ...(out.truncated ? { truncated: true as const } : {}) });
      else setRepos(out.none === true ? { list: [], none: true } : { list: [], problem: out.failure.message });
    });
  }, [wantRepos, hub.id]);

  // The bot New bot is making from a pick here, until the hub lists it and its chat opens.
  const creating = add?.add.phase.kind === "creating" ? add.add.phase : null;
  const project: ProjectStep =
    bots[0] !== undefined
      ? { at: "made", name: bots[0].project.title }
      : creating !== null && joined !== null
        ? { at: "adding", what: creating.title, machine: joined.name }
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
            ...(repos.truncated === true ? { truncated: true as const } : {}),
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
          ...(tailscale === undefined ? {} : { tailscale }),
          claude,
          ...(tailnetState === undefined ? {} : { tailnet: tailnetState.status === "connected" }),
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
    onHostedRetry: () => {
      if (hosted === undefined) return;
      setHostedTrying(true);
      setHostedTried(null);
      call("sandbox_test", { provider: hosted.provider }).then(
        () => {
          setHostedTrying(false);
          refetch(["sandbox_get"]);
          hostedWait.again();
        },
        (e: unknown) => {
          setHostedTrying(false);
          setHostedTried(errorText(e));
        },
      );
    },
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
    onClaudeAccount: () => navigate({ id: "settings", tab: "accounts" }),
    onClaudeKey: (saved, key) => {
      if (key.trim() === "") {
        setKeyState({ error: "Paste the API key from the Claude Console." });
        return;
      }
      // Sealed in main to every machine that takes secrets (the agents' Mac never), as Settings › Hub › Setup › Claude.
      const boxes = Object.values(machines)
        .flatMap((m) => (typeof m.boxPubKey === "string" && m.agentsMac !== true ? [{ machineId: m.machineId, boxPubKey: m.boxPubKey }] : []))
        .sort((a, b) => a.machineId.localeCompare(b.machineId));
      const request: ClaudeAccountRequest = { account: "hub_api", key, ...(saved === undefined ? {} : { endpoint: saved }), boxes };
      setKeyState({ busy: true });
      void window.fleetd.secret.claudeAccount(hub.id, request).then(
        (out) => {
          if (!mounted.current) return;
          if (!out.ok) {
            setKeyState({ error: errorText(new CallError(out.error)) });
            return;
          }
          setKeyState(undefined);
          refetch(["claude_accounts_get"]);
          // Tried at once, as Settings does: the hub keeps it as the key's last Test.
          void call("claude_account_test", { account: "hub_api" }, { timeoutMs: 120_000 }).then(
            () => refetch(["claude_accounts_get"]),
            () => undefined,
          );
        },
        (e: unknown) => mounted.current && setKeyState({ error: errorText(e) }),
      );
    },
    onTailscale: () => {
      writeKept(hub.id, { tailscale: null });
      setTailnetBusy(true);
      setTailnetProblem(null);
      call("tailnet_connect", noInput, { timeoutMs: 180_000 })
        .then(
          async (st) => {
            if (st.loginUrl === undefined) return;
            const opened = await window.fleetd.openExternal(st.loginUrl);
            if (!opened.ok && mounted.current) setTailnetProblem(opened.message);
          },
          (e: unknown) => mounted.current && setTailnetProblem(`Not connected: ${errorText(e)}`),
        )
        .finally(() => {
          if (mounted.current) setTailnetBusy(false);
          refetch(["tailnet_get"]);
        });
    },
    onTailscaleOpen: () => {
      // Approval waits in Tailscale's admin console.
      const url = tailnetState?.status === "approve" ? "https://login.tailscale.com/admin/machines" : tailnetState?.loginUrl;
      if (url !== undefined) void window.fleetd.openExternal(url);
    },
    onTailscaleSkip: () => writeKept(hub.id, { tailscale: "skipped" }),
    onRepo: (owner, name) => {
      // On the computer, else in the hosted sandboxes (the hub's runner).
      const on = joined?.machineId ?? (computer.at === "hosted" ? runnerMachine?.machineId : undefined);
      if (on !== undefined)
        startBot(on, {
          kind: "clone",
          repo: `${owner}/${name}`,
        });
    },
    onEmpty: () => {
      const on = joined?.machineId ?? (computer.at === "hosted" ? runnerMachine?.machineId : undefined);
      openAddProject(on === undefined ? undefined : { text: "", machine: on });
    },
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
