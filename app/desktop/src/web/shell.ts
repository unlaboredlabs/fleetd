// `window.fleetd` in a browser: the web app's half of the shell seam (the desktop's is the preload, src/preload). The
// renderer reaches its shell through FleetdApi alone, so this one file makes it a web app for fleetd cloud. What it
// does in place of each part of the desktop's shell:
//   the hub connection   each team's hub socket on this origin, the session's cookie its auth (hub.ts); no key, no cache
//   hubs                 the account's teams, as the session says; their names and colours kept in this browser
//   sign-in, sign-out    WorkOS's page by a navigation, and back (session.ts); the gate before the app (Gate.tsx)
//   secrets, the vault   sealed here with libsodium, as main seals them; a vault value is never shown or copied here
//   reports              the team's own address frames them (/t/<team>/web/frames), never this origin
//   files                read from the hub and saved by the browser; never opened in a tab of this origin
//   links, notifications new tabs; the browser's own notifications and a count in the tab's title
//   desktop-only         pairing, Set up this Mac, This computer, the tray, the app's update, folder pickers, GitHub's
//                        sign-in through 127.0.0.1: answered as needing the desktop app, and hidden by the screens
//                        (renderer/src/web.ts)
import type { FleetdApi } from "../preload/api";
import type { LinkHandlerStatus, OpenTarget } from "../shared/app";
import { framedPage } from "../shared/artifactPage";
import { fromBase64 } from "../shared/base64";
import type { CloudState, InstallGithubOutcome, InvitesOutcome } from "../shared/cloud";
import { safeFileName } from "../shared/files";
import type { CallOutcome, HubError, HubState } from "../shared/hub";
import { cleanLabel, HUB_COLORS, type HubColor, type HubEntry, type HubId } from "../shared/hubs";
import type { CallRequest, FileRequest } from "../shared/ipc";
import { readFile } from "../shared/transfer";
import type { UpdatesState } from "../shared/updates";
import { installGithub } from "../main/cloud/github";
import { listInvites, revokeInvite, sendInvite, type KeyedTeam } from "../main/cloud/invites";
import { externalUrl } from "../main/external";
import type { Transport } from "../main/hub/link";
import { submitClaudeAccount, submitHubLink, submitMcpOauthClient, submitMcpServer, submitOnePassword, submitProjectEnv, submitRevylKey, submitSecret } from "../main/secret";
import { sessionHash } from "../shared/sessionHash";
import { saveVaultItem, unlockVault } from "../main/vault";
import { WebHub } from "./hub";
import { readSession, signInPath, teamHubId, teamHubIds, teamPath, webCall, WEB_HEADER, type Fetch, type WebSession, type WebTeam } from "./session";

/** What a desktop-only part answers here; the screens hide those parts, so it is a last word, not a control. */
export const NEEDS_DESKTOP = "This needs the fleetd desktop app.";
const desktopOnly: HubError = { code: "desktop_only", message: NEEDS_DESKTOP, fix: "Download it from fleetd.sh." };

/** What the shell needs of the browser; tests give fakes. */
export interface WebDeps {
  readonly fetch: Fetch;
  readonly transport: Transport;
  /** This page's origin, `https://app.fleetd.dev`. */
  readonly origin: string;
  /** This page's path and route, for Sign in to come back to. */
  readonly here: () => string;
  /** A navigation of this tab (sign-in, sign-out). */
  readonly go: (path: string) => void;
  readonly reload: () => void;
  /** A new tab; null when the browser blocked it. */
  readonly open: (url: string, name?: string) => Window | null;
  readonly copy: (text: string) => Promise<void>;
  /** Saves bytes as a download under `name`. */
  readonly save: (name: string, blob: Blob) => void;
  readonly copyImage: (blob: Blob) => Promise<void>;
  readonly notify: (title: string, options: { body: string; tag: string }, onClick: () => void) => Promise<boolean>;
  readonly setTitle: (count: number) => void;
  readonly random: (bytes: number) => Uint8Array;
  /** Names and colours the person gave teams in this browser. */
  readonly storage: Pick<Storage, "getItem" | "setItem">;
  readonly platform: FleetdApi["platform"];
  readonly version: string;
}

/** The platform the keys say: ⌘ on a Mac. */
export const platformOf = (navigatorPlatform: string): FleetdApi["platform"] =>
  /^mac|iphone|ipad/iu.test(navigatorPlatform) ? "darwin" : /^win/iu.test(navigatorPlatform) ? "win32" : /linux|cros|android/iu.test(navigatorPlatform) ? "linux" : "other";

const NAMES_KEY = "fleetd.web.teams";
type Names = Record<string, { label?: string; color?: HubColor }>;

const readNames = (storage: WebDeps["storage"]): Names => {
  try {
    const raw: unknown = JSON.parse(storage.getItem(NAMES_KEY) ?? "{}");
    return typeof raw === "object" && raw !== null ? (raw as Names) : {};
  } catch {
    return {};
  }
};

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** A team's socket address on this origin. */
export const socketUrl = (origin: string, teamId: string): string => `${origin.replace(/^http/u, "ws")}${teamPath(teamId, "/app")}`;

/** The report frame's address the cloud answered: on another origin than this page's, or none. */
export const frameUrl = (answer: unknown, origin: string): string | null => {
  const raw = typeof answer === "object" && answer !== null ? (answer as { url?: unknown }).url : undefined;
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const page = new URL(origin);
  // https, or http on this machine for a stand-in: never this page's own origin, where the report could reach the session.
  const local = url.protocol === "http:" && page.protocol === "http:";
  if ((url.protocol !== "https:" && !local) || url.origin === page.origin || url.username !== "" || url.password !== "") return null;
  return url.href;
};

/** The shell for a signed-in session, and its teams' hubs (for followBrowser). */
export const createWebShell = (session: WebSession, deps: WebDeps): { readonly api: FleetdApi; readonly hubs: readonly WebHub[] } => {
  const teams = new Map<HubId, WebTeam>();
  const ids = teamHubIds(session.teams.map((t) => t.id));
  for (const team of session.teams) teams.set(ids.get(team.id) ?? teamHubId(team.id), team);
  let names = readNames(deps.storage);
  const entries = (): readonly HubEntry[] =>
    [...teams].map(([id, team]) => {
      const own = names[team.id];
      return { id, label: own?.label ?? team.name, cloud: true, ...(own?.color === undefined ? {} : { color: own.color }) };
    });
  const listListeners = new Set<(list: readonly HubEntry[]) => void>();

  // A refused socket, or one that keeps failing at the upgrade (which the browser can't tell apart): signed out, the
  // tab goes to Sign in; out of a team since, the page starts again with the teams as they are now.
  let checking = false;
  let checkedAt = 0;
  const recheck = () => {
    const now = Date.now();
    if (checking || now - checkedAt < 10_000) return;
    checking = true;
    checkedAt = now;
    void readSession(deps.fetch).then((read) => {
      checking = false;
      if (!read.ok && read.signedOut === true) deps.go(signInPath(deps.here()));
      else if (read.ok && read.session.teams.map((t) => t.id).join() !== session.teams.map((t) => t.id).join()) deps.reload();
    });
  };
  const onState = (state: HubState) => {
    if (state.phase === "refused" || state.phase === "retrying") recheck();
  };
  const hubs = new Map<HubId, WebHub>();
  for (const [id, team] of teams) hubs.set(id, new WebHub(team.url, socketUrl(deps.origin, team.id), deps.transport, onState));

  const gone: CallOutcome = { ok: false, error: { code: "offline", message: "That team isn't in this account." } };
  const call = (id: HubId) => (tool: string, input: unknown, timeoutMs?: number) =>
    hubs.get(id)?.call({ tool, input: input as CallRequest["input"], ...(timeoutMs === undefined ? {} : { timeoutMs }) }) ?? Promise.resolve(gone);

  /** A team's own HTTP paths, as the desktop's calls to the team's address are made: the cookie stands in for the key. */
  const keyed = (id: HubId): KeyedTeam | null => {
    const team = teams.get(id);
    return team === undefined ? null : { origin: teamPath(team.id), key: "", name: names[team.id]?.label ?? team.name };
  };
  const teamFetch: Fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    for (const [k, v] of Object.entries(WEB_HEADER)) headers.set(k, v);
    return deps.fetch(input, { ...init, headers, credentials: "same-origin" });
  };
  const notTeam = { ok: false as const, failure: { code: "", message: "That team isn't in this account." } };

  const readBytes = async (id: HubId, request: FileRequest): Promise<{ ok: true; name: string; blob: Blob } | { ok: false; message: string }> => {
    const got = await readFile((tool, input) => call(id)(tool, input), { projectRef: request.projectRef, attachmentId: request.attachmentId });
    if (!got.ok) return { ok: false, message: `The file couldn't be read: ${got.message}` };
    const { name, mime, dataB64 } = got.file as { name?: unknown; mime?: unknown; dataB64?: unknown };
    const bytes = typeof dataB64 === "string" ? fromBase64(dataB64) : null;
    if (typeof name !== "string" || typeof mime !== "string" || bytes === null) return { ok: false, message: "The hub sent no file." };
    // Saved, never shown in a tab here: a page or picture an agent made would run on this origin.
    return { ok: true, name: safeFileName(name, mime), blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" }) };
  };
  const download = async (id: HubId, request: FileRequest) => {
    const got = await readBytes(id, request);
    if (!got.ok) return got;
    deps.save(got.name, got.blob);
    return { ok: true as const, name: got.name };
  };

  const openListeners = new Set<(target: OpenTarget) => void>();
  const opened = (target: OpenTarget) => {
    for (const listener of openListeners) listener(target);
  };

  const updates: UpdatesState = { current: deps.version, app: { kind: "unsupported" }, release: null };
  const linkHandler: LinkHandlerStatus = { packaged: false, handler: false };
  const domain = (() => {
    try {
      return new URL(session.teams[0]?.url ?? "").hostname.split(".").slice(1).join(".") || null;
    } catch {
      return null;
    }
  })();
  const cloud: CloudState = { available: true, email: session.email, domain };
  const never = <T>(): Promise<T> => Promise.reject(new Error(NEEDS_DESKTOP));

  const api: FleetdApi = {
    shell: "web",
    platform: deps.platform,
    fixture: null,
    vibrancy: false,
    softwareCompositing: false,
    version: deps.version,
    copy: (text) => deps.copy(text),
    artifactFrame: async (html, hub) => {
      const team = hub === undefined ? session.teams[0] : teams.get(hub);
      if (team === undefined) throw new Error("No team to show this report on.");
      const key = hex(deps.random(16));
      const answer = await webCall(deps.fetch, "POST", teamPath(team.id, "/web/frames"), { html: framedPage(html, key) });
      if (!answer.ok) throw new Error(answer.signedOut === true ? "Signed out." : answer.failure.message);
      const url = frameUrl(answer.body, deps.origin);
      if (url === null) throw new Error("fleetd cloud answered with no address to show the report at.");
      return { url, key };
    },
    secret: {
      submit: (hub, request) => submitSecret(request, call(hub)),
      projectEnv: (hub, request) => submitProjectEnv(request, call(hub)),
      mcpServer: (hub, request) => submitMcpServer(request, call(hub)),
      hubLink: (hub, request) => submitHubLink(request, call(hub)),
      revylKey: (hub, request) => submitRevylKey(request, call(hub)),
      mcpOauthClient: (hub, request) => submitMcpOauthClient(request, call(hub)),
      claudeAccount: (hub, request) => submitClaudeAccount(request, call(hub)),
      onePassword: (hub, request) => submitOnePassword(request, call(hub)),
    },
    vault: {
      save: (hub, request) => saveVaultItem(request, call(hub)),
      // A value is shown only behind Touch ID or Face ID, in the desktop and phone apps.
      reveal: () => Promise.resolve({ ok: false, error: desktopOnly }),
      copy: () => Promise.resolve({ ok: false, error: desktopOnly }),
      unlock: (hub, request) => unlockVault(request, call(hub)),
    },
    github: {
      createApp: () => Promise.resolve({ ok: false, error: desktopOnly }),
      // GitHub's sign-in comes back to 127.0.0.1, where only the desktop app listens.
      connect: () => Promise.resolve({ ok: false, error: desktopOnly }),
      cancel: () => Promise.resolve(),
    },
    openExternal: (url) => {
      const checked = externalUrl(url);
      if (!checked.ok) return Promise.resolve(checked);
      return Promise.resolve(deps.open(checked.url) === null ? { ok: false, message: "The browser blocked the new tab. Allow pop-ups for this site, then try again." } : { ok: true });
    },
    files: {
      open: (hub, request) => download(hub, request).then((out) => (out.ok ? { ok: true } : out)),
      save: (hub, request) => download(hub, request).then((out) => (out.ok ? { ok: true } : out)),
      download: (hub, request) => download(hub, request).then((out) => (out.ok ? { ok: true, path: "", name: out.name } : out)),
      show: () => Promise.resolve({ ok: false, message: NEEDS_DESKTOP }),
      copyImage: async (hub, request) => {
        const got = await readBytes(hub, request);
        if (!got.ok) return got;
        try {
          await deps.copyImage(got.blob);
          return { ok: true };
        } catch {
          return { ok: false, message: "This browser didn't copy the picture. Save it instead." };
        }
      },
    },
    hubs: {
      initial: entries(),
      list: () => Promise.resolve(entries()),
      subscribe: (listener) => {
        listListeners.add(listener);
        return () => listListeners.delete(listener);
      },
      update: (hub, change) => {
        const team = teams.get(hub);
        const label = cleanLabel(change.label);
        if (team === undefined) return Promise.resolve({ ok: false, message: "That team isn't in this account." });
        if (label === null) return Promise.resolve({ ok: false, message: "Give it a name." });
        if (change.color !== null && !HUB_COLORS.includes(change.color)) return Promise.resolve({ ok: false, message: "Pick one of the colours." });
        names = { ...names, [team.id]: { label, ...(change.color === null ? {} : { color: change.color }) } };
        deps.storage.setItem(NAMES_KEY, JSON.stringify(names));
        const list = entries();
        for (const listener of listListeners) listener(list);
        return Promise.resolve({ ok: true });
      },
    },
    hub: {
      subscribe: (hub, listener) => {
        const team = hubs.get(hub);
        if (team !== undefined) return team.subscribe(listener);
        listener({ t: "state", state: { phase: "unpaired" } });
        return () => undefined;
      },
      call: (hub, tool, input, options) => hubs.get(hub)?.call({ tool, input: input as CallRequest["input"], ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) }) ?? Promise.resolve(gone),
      chat: (hub, project) => Promise.resolve(hubs.get(hub)?.chat(project)),
      focus: (hub, workstreamId) => Promise.resolve(hubs.get(hub)?.focus(workstreamId)),
      watch: (hub, s) => Promise.resolve(hubs.get(hub)?.watch(s)),
      input: (hub, s, input) => Promise.resolve(hubs.get(hub)?.input(s, input)),
      thumbs: (hub, on) => Promise.resolve(hubs.get(hub)?.thumbs(on)),
      resync: (hub) => Promise.resolve(hubs.get(hub)?.resync()),
      retryNow: (hub) => Promise.resolve(hubs.get(hub)?.retryNow()),
      // Nothing of a team's is kept in the browser: a shared computer keeps no chat after the tab closes.
      cache: { read: () => Promise.resolve(null), write: () => Promise.resolve() },
      connect: () => Promise.resolve({ ok: false, message: NEEDS_DESKTOP }),
      forget: () => Promise.resolve(),
    },
    pair: { start: never, probe: never, redeem: never, auto: never, store: never, setup: never },
    cloud: {
      state: () => Promise.resolve(cloud),
      signIn: () => Promise.resolve({ ok: false, cancelled: true }),
      finish: () => Promise.resolve({ ok: false, failure: { code: "", message: NEEDS_DESKTOP } }),
      notMe: () => Promise.resolve(),
      cancel: () => Promise.resolve(),
      reopen: () => Promise.resolve(),
      link: () => Promise.resolve(null),
      signOut: async () => {
        const out = await webCall(deps.fetch, "POST", "/web/sign-out");
        // Signed out already (a 401) is signed out; any other failure leaves the session as it was, and says so.
        if (!out.ok && out.signedOut !== true) {
          const { code, message, fix } = out.failure;
          return { kept: [], failure: { code, message: `Not signed out: ${message}`, ...(fix === undefined ? {} : { fix }) } };
        }
        deps.go("/");
        return { kept: [] };
      },
      connectComputer: () => Promise.resolve({ ok: false, message: "Run the line below in a terminal on the computer." }),
      invites: (hub): Promise<InvitesOutcome> => {
        const team = keyed(hub);
        return team === null ? Promise.resolve(notTeam) : listInvites(teamFetch, team);
      },
      invite: (hub, request) => {
        const team = keyed(hub);
        return team === null ? Promise.resolve(notTeam) : sendInvite(teamFetch, team, request);
      },
      revokeInvite: (hub, inviteId) => {
        const team = keyed(hub);
        return team === null ? Promise.resolve(notTeam) : revokeInvite(teamFetch, team, inviteId);
      },
      installGithub: (hub): Promise<InstallGithubOutcome> => {
        const team = keyed(hub);
        if (team === null) return Promise.resolve(notTeam);
        return installGithub(teamFetch, team, (url) => (deps.open(url) === null ? Promise.reject(new Error("the browser blocked the new tab; allow pop-ups for this site")) : Promise.resolve()));
      },
    },
    system: { hostName: () => Promise.resolve("") },
    machines: {
      joinHere: never,
      thisComputer: () => Promise.resolve({ kind: "none" }),
      joinHereState: () => Promise.resolve(null),
      onJoinHere: () => () => undefined,
    },
    macSetup: { open: never, redeem: never, join: never, onJoin: () => () => undefined, health: never, openPane: never, restart: never, status: never, cancel: never, updateHub: never },
    menuBar: { read: () => Promise.resolve(null), fit: never, hide: never, menu: never },
    projects: { pickFolder: () => Promise.resolve(null), readDrop: () => Promise.resolve({ kind: "other" }) },
    updates: {
      // fleetd cloud serves the newest web app: a reload is the update.
      state: () => Promise.resolve(updates),
      subscribe: () => () => undefined,
      check: () => Promise.resolve(),
      install: () => Promise.resolve(),
    },
    app: {
      onMenuCommand: () => () => undefined,
      onOpen: (listener) => {
        openListeners.add(listener);
        return () => openListeners.delete(listener);
      },
      notify: (request) => deps.notify(request.title, { body: request.body, tag: request.tag }, () => opened(request.target)),
      setBadge: (count) => Promise.resolve(deps.setTitle(count)),
      sessionWindow: (request) => {
        deps.open(`${new URL(deps.here(), deps.origin).pathname}${sessionHash(request)}`, `fleetd-session-${request.session}`);
        return Promise.resolve();
      },
      setTheme: () => Promise.resolve(),
      linkHandler: () => Promise.resolve(linkHandler),
      presence: () => Promise.resolve(false),
      setMenuState: () => Promise.resolve(),
      logError: (report) => {
        console.error(`${report.what} (${report.route}):`, report.message, report.stack ?? "");
        return Promise.resolve();
      },
    },
  };
  return { api, hubs: [...hubs.values()] };
};

/** Back-forward cache, the network, the tab shown: what main hears from the OS, the page hears from the browser. */
export const followBrowser = (hubs: Iterable<WebHub>, target: Pick<Window, "addEventListener"> & { readonly document: Pick<Document, "visibilityState" | "addEventListener"> }): void => {
  const each = (fn: (hub: WebHub) => void) => {
    for (const hub of hubs) fn(hub);
  };
  target.addEventListener("online", () => each((h) => h.probe()));
  target.addEventListener("pageshow", (e) => {
    if (e.persisted) each((h) => h.probe());
  });
  target.document.addEventListener("visibilitychange", () => each((h) => h.shown(target.document.visibilityState === "visible")));
};
