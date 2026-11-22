// Connections (D653): one sheet over the app, opened from the plain icon at the sidebar's foot (ConnectionsHost). Its
// head is the title and what is connected (each one's mark and a count). Then the few named connections, one line
// each: Paper and Notion (hosted MCP servers the team signs in to once: Connect saves it and opens the service's own
// sign-in) and Tailscale (the hub's route to the team's tailnet). Then Custom MCP: every other server, the team's and
// a bot's own, each with its state, Sign in when it wants one, and a menu: Test, Edit, Bots, Disconnect. Add opens the
// form in the sheet's place (CustomForm.tsx). A custom MCP on the tailnet is reached through Tailscale with nothing
// else to set. At the foot, for an admin: whether agents also get their machine's own Claude MCP servers. What
// replaced Settings' Integrations, MCP servers and Machines' Network.
import { Dialog as D } from "radix-ui";
import { ArrowLeft, Ellipsis, Plus, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { McpServer, McpServerSetOutput, ProjectRef, TailnetState } from "../../../shared/contracts";
import type { McpServerRequest } from "../../../shared/ipc";
import { CallError } from "../../src/data/queries";
import { useData, useDataLayer, useToolQueries, useToolQuery } from "../../src/data/react";
import { Button, cx, Dialog, Menu, MenuCheckboxItem, MenuContent, MenuItem, MenuSeparator, MenuSub, MenuTrigger, Switch, Tooltip } from "../../ui";
import { useSettledAdministers } from "../admin/role";
import { errorText, useHubCall, useLive, useRefetch } from "../settings/hub";
import { NAMED, namedInput, namedState, turnOnInput, type Named } from "../settings/namedServers";
import { useProjects } from "../settings/parts";
import { useTailnet, type Tailnet } from "../settings/Tailscale";
import { canConnect, lineOf, MACHINES_URL, waiting, wordOf } from "../settings/tailscaleModel";
import { CustomForm } from "./CustomForm";
import { Mark, Monogram, TailscaleMark } from "./marks";
import {
  botsText,
  connectedOf,
  countText,
  customOf,
  isTailnetHost,
  needsSignIn,
  stateOf,
  testLine,
  toggleBot,
  urlOf,
  whereOf,
  withBots,
  type StripItem,
  type Tested,
} from "./model";
import { Problem, SignInDialog, words } from "./SignIn";
import { requestOf } from "./signInModel";
import c from "./connections.module.css";

const noInput = {};
const open = (url: string): void => void window.fleetd.openExternal(url);

type View = { kind: "list" } | { kind: "add" } | { kind: "edit"; server: McpServer };
type Dialogs = { kind: "signin"; server: McpServer; named?: Named | undefined } | { kind: "disconnect"; server: McpServer; label: string } | { kind: "tailscale-off"; state: TailnetState };

interface Bot extends ProjectRef {
  readonly title: string;
}

/** The bots a server may be given: every bot on the hub that isn't archived, by name. */
function useBots(): Bot[] {
  const projects = useProjects();
  return (projects ?? []).filter((p) => p.archivedAt === undefined).map((p) => ({ machineId: p.machineId, projectId: p.projectId, title: p.title }));
}

/** Each bot's own servers (a bot's own came before the team's, D592), one read per bot. */
function useOwn(bots: ReadonlyArray<Bot>): McpServer[] {
  const reads = useToolQueries(
    "mcp_servers_get",
    bots.map((b) => ({ project: { machineId: b.machineId, projectId: b.projectId } })),
  );
  return reads.flatMap((r) => r.data?.project ?? []);
}

/** A machine's name, for where a Test ran. */
const useMachineName = () => {
  const machines = useData((d) => d.machines);
  return (id: string) => machines[id]?.name ?? id;
};

/** Saves through main (which seals nothing here: values are plain, kept or vault items) and reads again. */
function useSave() {
  const { hub } = useDataLayer();
  const refetch = useRefetch();
  return async (request: McpServerRequest): Promise<McpServer> => {
    const out = await window.fleetd.secret.mcpServer(hub, request);
    if (!out.ok) throw new CallError(out.error);
    refetch(["mcp_servers_get", "setup_list"]);
    return (out.output as McpServerSetOutput).server;
  };
}

/** Tests a saved server, its outcome kept by name for its row. */
function useTests() {
  const hubCall = useHubCall();
  const [tests, setTests] = useState<Readonly<Record<string, Tested | "testing">>>({});
  const key = (s: McpServer) => `${s.scope.kind === "global" ? "" : s.scope.projectId}:${s.name}`;
  const run = async (server: McpServer): Promise<Tested> => {
    setTests((t) => ({ ...t, [key(server)]: "testing" }));
    const tested = await hubCall("mcp_server_test", { scope: server.scope, name: server.name }).then(
      (out): Tested => ({ machineId: out.machineId, result: out.result }),
      (e: unknown): Tested => ({ error: errorText(e) }),
    );
    setTests((t) => ({ ...t, [key(server)]: tested }));
    return tested;
  };
  return { of: (s: McpServer) => tests[key(s)], run };
}

export function ConnectionsSheet({ onClose }: { onClose: () => void }) {
  const live = useLive();
  const admin = useSettledAdministers();
  const read = useToolQuery("mcp_servers_get", noInput, { enabled: live });
  const bots = useBots();
  const own = useOwn(bots);
  const tailnet = useTailnet();
  const [view, setView] = useState<View>({ kind: "list" });
  const [dialog, setDialog] = useState<Dialogs | null>(null);
  const tests = useTests();
  const team = read.data?.global ?? [];
  const strip = connectedOf(team, own, tailnet.state);
  const custom = customOf(team, own);
  const taken = [...team, ...own].map((s) => s.name);
  const form = view.kind !== "list";
  return (
    <D.Root open onOpenChange={(o) => !o && dialog === null && onClose()}>
      <D.Portal>
        <D.Overlay className={c.scrim} />
        <D.Content className={c.sheet} {...(form ? { "data-screen": "connections.form" } : read.data === undefined ? {} : { "data-screen": "connections" })} aria-describedby={undefined}
          // The sheet itself takes focus as it opens, not its × (a ring on it at rest): Tab goes on from there.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).focus();
          }}
        >
          <header className={c.head}>
            {form ? (
              <Button variant="quiet" iconOnly aria-label="Back to Connections" className={c.back} onClick={() => setView({ kind: "list" })}>
                <ArrowLeft aria-hidden />
              </Button>
            ) : null}
            <D.Title className={c.title}>{view.kind === "add" ? "Custom MCP" : view.kind === "edit" ? view.server.name : "Connections"}</D.Title>
            {form ? null : <Strip items={strip} />}
            <D.Close asChild>
              <Button variant="quiet" iconOnly aria-label="Close" className={c.close}>
                <X aria-hidden />
              </Button>
            </D.Close>
          </header>
          {form ? (
            <CustomForm
              key={view.kind === "edit" ? view.server.name : "add"}
              editing={view.kind === "edit" ? view.server : null}
              taken={taken}
              bots={bots}
              tailnet={tailnet}
              admin={admin}
              onDone={() => setView({ kind: "list" })}
            />
          ) : (
            <div className={c.body}>
              <ul className={c.group} aria-label="Connections">
                {NAMED.map((entry) => (
                  <NamedRow key={entry.id} entry={entry} team={team} bots={bots} tests={tests} onDialog={setDialog} />
                ))}
                {tailnet.state === undefined ? null : <TailscaleRow state={tailnet.state} tailnet={tailnet} admin={admin} onDisconnect={(state) => setDialog({ kind: "tailscale-off", state })} />}
              </ul>
              <div className={c.label}>
                <h3 className={c.labelText}>Custom MCP</h3>
                {custom.length === 0 ? null : (
                  <Button variant="ghost" iconOnly aria-label="Add a custom MCP" title="Add a custom MCP" className={c.add} onClick={() => setView({ kind: "add" })}>
                    <Plus aria-hidden />
                  </Button>
                )}
              </div>
              <ul className={c.group} aria-label="Custom MCP">
                {custom.length === 0 ? (
                  <li className={c.row}>
                    <button type="button" className={c.addRow} onClick={() => setView({ kind: "add" })}>
                      <span className={cx(c.tile, c.tileAdd)} aria-hidden>
                        <Plus />
                      </span>
                      <span className={c.name}>Add a custom MCP</span>
                    </button>
                  </li>
                ) : (
                  custom.map((server) => (
                    <CustomRow
                      key={`${server.scope.kind === "global" ? "" : server.scope.projectId}:${server.name}`}
                      server={server}
                      bots={bots}
                      tests={tests}
                      tailnet={tailnet.state}
                      onEdit={() => setView({ kind: "edit", server })}
                      onDialog={setDialog}
                    />
                  ))
                )}
              </ul>
              {admin && read.data !== undefined ? <UserServers on={read.data.userServers} /> : null}
            </div>
          )}
          {dialog?.kind === "signin" ? (
            <SignInDialog server={dialog.server} named={dialog.named} onClose={() => setDialog(null)} onSignedIn={() => void tests.run(dialog.server)} />
          ) : null}
          {dialog?.kind === "disconnect" ? <Disconnect server={dialog.server} label={dialog.label} onClose={() => setDialog(null)} /> : null}
          {dialog?.kind === "tailscale-off" ? <TailscaleOff state={dialog.state} tailnet={tailnet} onClose={() => setDialog(null)} /> : null}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

/** What is connected, at the head's end: each one's mark, overlapping, and how many. Nothing while nothing is. */
function Strip({ items }: { items: ReadonlyArray<StripItem> }) {
  const text = countText(items.length);
  if (text === null) return null;
  const shown = items.slice(0, 4);
  return (
    <Tooltip content={items.map((i) => i.label).join(", ")}>
      <div className={c.strip} role="status" aria-label={`${text}: ${items.map((i) => i.label).join(", ")}`} data-connected={items.length}>
        <span className={c.stack3}>
          {shown.map((i) => (
            <span key={i.key} className={c.chip}>
              {i.named !== undefined ? <Mark entry={i.named} /> : i.tailscale === true ? <TailscaleMark /> : <Monogram name={i.label} />}
            </span>
          ))}
        </span>
        <span className={c.count}>{text}</span>
      </div>
    </Tooltip>
  );
}

/** A row's frame: its tile, its name with the state beside it, a line under for what the person needs now, its controls. */
function Row(props: {
  tile: ReactNode;
  name: string;
  where?: ReactNode;
  word?: { text: string; tone: "quiet" | "success" | "warning" | "danger" } | null | undefined;
  line?: { text: string; tone: "quiet" | "success" | "warning" | "danger" } | null | undefined;
  children?: ReactNode;
  controls?: ReactNode;
  data?: Record<`data-${string}`, string>;
}) {
  return (
    <li className={c.row} aria-label={props.name} {...props.data}>
      <span className={c.tile} aria-hidden>
        {props.tile}
      </span>
      <div className={c.main}>
        <div className={c.top}>
          <span className={c.name}>{props.name}</span>
          {props.where === undefined ? null : <span className={c.where}>{props.where}</span>}
          {props.word == null ? null : (
            <span className={c.word} data-tone={props.word.tone}>
              {props.word.text}
            </span>
          )}
        </div>
        {props.line == null ? null : (
          <span className={c.line} data-tone={props.line.tone} role={props.line.tone === "danger" ? "alert" : "status"}>
            {words(props.line.text)}
          </span>
        )}
        {props.children}
      </div>
      <div className={c.controls}>{props.controls}</div>
    </li>
  );
}

/** A row's "…": its actions past the first, Bots as a list to tick, Disconnect last. */
function RowMenu(props: { label: string; items: ReadonlyArray<{ label: string; onSelect: () => void }>; bots?: ReactNode; onDisconnect: () => void }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button size="sm" variant="ghost" iconOnly aria-label={`${props.label}: more`}>
          <Ellipsis aria-hidden />
        </Button>
      </MenuTrigger>
      <MenuContent align="end" className={c.menu}>
        {props.items.map((i) => (
          <MenuItem key={i.label} onSelect={i.onSelect}>
            {i.label}
          </MenuItem>
        ))}
        {props.bots}
        <MenuSeparator />
        <MenuItem danger onSelect={props.onDisconnect}>
          Disconnect
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

/** Bots, a list to tick: Every bot, then each by name. Each tick saves at once. */
function BotsSub({ server, bots, onPick }: { server: McpServer; bots: ReadonlyArray<Bot>; onPick: (next: ProjectRef[] | undefined) => void }) {
  if (server.scope.kind !== "global" || bots.length === 0) return null;
  const every = server.projects === undefined;
  return (
    <MenuSub label="Bots" hint={botsText(server, bots)}>
      <MenuCheckboxItem checked={every} onSelect={(e) => e.preventDefault()} onCheckedChange={() => onPick(every ? [] : undefined)}>
        Every bot
      </MenuCheckboxItem>
      <MenuSeparator />
      {bots.map((b) => (
        <MenuCheckboxItem
          key={`${b.machineId}/${b.projectId}`}
          checked={every || (server.projects ?? []).some((p) => p.machineId === b.machineId && p.projectId === b.projectId)}
          onSelect={(e) => e.preventDefault()}
          onCheckedChange={() => onPick(toggleBot(server.projects, b, bots))}
        >
          {b.title}
        </MenuCheckboxItem>
      ))}
    </MenuSub>
  );
}

function NamedRow(props: { entry: Named; team: ReadonlyArray<McpServer>; bots: ReadonlyArray<Bot>; tests: ReturnType<typeof useTests>; onDialog: (d: Dialogs) => void }) {
  const { entry } = props;
  const save = useSave();
  const machine = useMachineName();
  const [busy, setBusy] = useState<"connect" | "on" | "bots" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const state = namedState(entry, props.team);
  const server = state.kind === "add" ? undefined : state.server;
  const tested = server === undefined ? undefined : props.tests.of(server);
  const result = tested === undefined || tested === "testing" ? undefined : tested;
  const signIn = server !== undefined && (state.kind === "signin" || (state.kind === "connected" && needsSignIn(server, result)));
  const run = (what: "connect" | "on" | "bots", request: McpServerRequest, then: (saved: McpServer) => void = () => undefined) => {
    setBusy(what);
    setProblem(null);
    save(request).then(
      (saved) => {
        setBusy(null);
        then(saved);
      },
      (e: unknown) => {
        setBusy(null);
        setProblem(errorText(e));
      },
    );
  };
  const connect = () =>
    run("connect", requestOf(namedInput(entry, { kind: "global" }, props.team.map((x) => x.name))), (saved) => props.onDialog({ kind: "signin", server: saved, named: entry }));
  const word =
    state.kind === "connected" && !signIn
      ? { text: server?.scope.kind === "global" && server.projects !== undefined ? botsText(server, props.bots) : "Connected", tone: "quiet" as const }
      : state.kind === "signing"
        ? { text: "Signing in…", tone: "quiet" as const }
        : state.kind === "off"
          ? { text: "Off", tone: "quiet" as const }
          : signIn
            ? { text: "Sign in needed", tone: "warning" as const }
            : null;
  const why = problem ?? (state.kind === "signin" ? (state.problem ?? null) : null);
  const line = why !== null ? { text: why, tone: "danger" as const } : tested === "testing" ? { text: "Testing…", tone: "quiet" as const } : result !== undefined && !signIn ? testLine(result, machine("machineId" in result ? result.machineId : "")) : null;
  return (
    <Row tile={<Mark entry={entry} />} name={entry.label} word={word} line={line} data={{ "data-named": entry.id, "data-state": state.kind }}
      controls={
        server === undefined ? (
          <Button size="sm" disabled={busy !== null} onClick={connect}>
            {busy === "connect" ? "Connecting…" : "Connect"}
          </Button>
        ) : (
          <>
            {signIn ? (
              <Button size="sm" onClick={() => props.onDialog({ kind: "signin", server, named: entry })}>
                Sign in
              </Button>
            ) : null}
            {state.kind === "off" ? (
              <Button size="sm" disabled={busy !== null} onClick={() => run("on", requestOf(turnOnInput(server)))}>
                {busy === "on" ? "Turning on…" : "Turn on"}
              </Button>
            ) : null}
            <RowMenu
              label={entry.label}
              items={[{ label: "Test", onSelect: () => void props.tests.run(server) }]}
              bots={<BotsSub server={server} bots={props.bots} onPick={(next) => run("bots", requestOf(withBots(server, next)))} />}
              onDisconnect={() => props.onDialog({ kind: "disconnect", server, label: entry.label })}
            />
          </>
        )
      }
    />
  );
}

function CustomRow(props: { server: McpServer; bots: ReadonlyArray<Bot>; tests: ReturnType<typeof useTests>; tailnet: TailnetState | undefined; onEdit: () => void; onDialog: (d: Dialogs) => void }) {
  const { server } = props;
  const save = useSave();
  const machine = useMachineName();
  const [problem, setProblem] = useState<string | null>(null);
  const tested = props.tests.of(server);
  const result = tested === undefined || tested === "testing" ? undefined : tested;
  const signIn = needsSignIn(server, result);
  const url = urlOf(server);
  // By its host, or by a Test that reached it through Tailscale (a MagicDNS name under the tailnet's own domain).
  const onTailnet = (url !== null && isTailnetHost(url)) || (result !== undefined && !("error" in result) && result.result.via === "tailnet");
  const state = stateOf(server);
  const bots = botsText(server, props.bots);
  const word = state ?? (bots === "Every bot" ? null : { text: bots, tone: "quiet" as const });
  // On the tailnet while Tailscale isn't connected: the one thing to do, said where it shows.
  const unreached = onTailnet && props.tailnet !== undefined && props.tailnet.status !== "connected";
  const line =
    problem !== null
      ? { text: problem, tone: "danger" as const }
      : tested === "testing"
        ? { text: "Testing…", tone: "quiet" as const }
        : result !== undefined && !signIn
          ? testLine(result, machine("machineId" in result ? result.machineId : ""))
          : signIn && server.oauth?.problem !== undefined
            ? { text: server.oauth.problem, tone: "danger" as const }
            : unreached
            ? { text: "On your tailnet: connect Tailscale above to reach it.", tone: "warning" as const }
            : null;
  const where = (
    <>
      {onTailnet ? (
        <Tooltip content="On your tailnet: reached through Tailscale">
          <span className={c.via} aria-label="through Tailscale">
            <TailscaleMark />
          </span>
        </Tooltip>
      ) : null}
      <span className={c.whereText}>{whereOf(server)}</span>
    </>
  );
  return (
    <Row
      tile={<Monogram name={server.name} />}
      name={server.name}
      where={where}
      word={word}
      line={line}
      data={{ "data-custom": server.name, ...(onTailnet ? { "data-tailnet": "" } : {}) }}
      controls={
        <>
          {signIn ? (
            <Button size="sm" onClick={() => props.onDialog({ kind: "signin", server })}>
              Sign in
            </Button>
          ) : null}
          <RowMenu
            label={server.name}
            items={[
              { label: "Test", onSelect: () => void props.tests.run(server) },
              { label: "Edit", onSelect: props.onEdit },
            ]}
            bots={
              <BotsSub
                server={server}
                bots={props.bots}
                onPick={(next) => {
                  setProblem(null);
                  save(requestOf(withBots(server, next))).catch((e: unknown) => setProblem(errorText(e)));
                }}
              />
            }
            onDisconnect={() => props.onDialog({ kind: "disconnect", server, label: server.name })}
          />
        </>
      }
    />
  );
}

/** Tailscale's row: Connect, the sign-in or approval it waits on, then the tailnet's name with Disconnect. An admin's to change. */
function TailscaleRow({ state, tailnet, admin, onDisconnect }: { state: TailnetState; tailnet: Tailnet; admin: boolean; onDisconnect: (s: TailnetState) => void }) {
  const { connect, busy, problem } = tailnet;
  const pending = waiting(state);
  const said = lineOf(state, admin);
  const line = problem !== null ? { text: problem, tone: "danger" as const } : said;
  return (
    <Row tile={<TailscaleMark />} name="Tailscale" word={wordOf(state)} line={line} data={{ "data-tailscale": state.status }}
      controls={
        !admin ? null : state.status === "connected" ? (
          <Menu>
            <MenuTrigger asChild>
              <Button size="sm" variant="ghost" iconOnly aria-label="Tailscale: more">
                <Ellipsis aria-hidden />
              </Button>
            </MenuTrigger>
            <MenuContent align="end" className={c.menu}>
              <MenuItem danger onSelect={() => onDisconnect(state)}>
                Disconnect
              </MenuItem>
            </MenuContent>
          </Menu>
        ) : state.status === "login" && state.loginUrl !== undefined ? (
          <Button size="sm" onClick={() => open(state.loginUrl ?? "")}>
            Open sign-in
          </Button>
        ) : state.status === "approve" ? (
          <Button size="sm" onClick={() => open(MACHINES_URL)}>
            Open Tailscale
          </Button>
        ) : pending ? null : (
          <Button size="sm" disabled={busy || !canConnect(state)} onClick={connect}>
            {busy ? "Connecting…" : state.status === "failed" ? "Connect again" : "Connect"}
          </Button>
        )
      }
    />
  );
}

/** Agents also get the MCP servers of their machine's own Claude setup: the hub's one switch for it. */
function UserServers({ on }: { on: boolean }) {
  const call = useHubCall();
  const refetch = useRefetch();
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div className={c.foot}>
      <Tooltip content="Agents also load the MCP servers set up in Claude on each machine (~/.claude.json, a repo's .mcp.json).">
        <span className={c.footTitle}>Machines' own MCP servers</span>
      </Tooltip>
      <Switch
        label=""
        aria-label="Machines' own MCP servers"
        checked={on}
        onCheckedChange={(next) => {
          setProblem(null);
          call("mcp_settings_set", { userServers: next }).then(
            () => refetch(["mcp_servers_get"]),
            (e: unknown) => setProblem(errorText(e)),
          );
        }}
      />
      <Problem text={problem} />
    </div>
  );
}

function Disconnect({ server, label, onClose }: { server: McpServer; label: string; onClose: () => void }) {
  const call = useHubCall();
  const refetch = useRefetch();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const team = server.scope.kind === "global";
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      title={`Disconnect ${label}?`}
      description={team ? "Every bot's agents lose it now. Its sign-in or keys leave every machine." : "This bot's agents lose it now. Its keys leave the machine."}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setProblem(null);
              call("mcp_server_remove", { scope: server.scope, name: server.name }).then(
                () => {
                  refetch(["mcp_servers_get", "setup_list"]);
                  onClose();
                },
                (e: unknown) => {
                  setBusy(false);
                  setProblem(errorText(e));
                },
              );
            }}
          >
            {busy ? "Disconnecting…" : "Disconnect"}
          </Button>
        </>
      }
    >
      <Problem text={problem} />
    </Dialog>
  );
}

function TailscaleOff({ state, tailnet, onClose }: { state: TailnetState; tailnet: Tailnet; onClose: () => void }) {
  const call = useHubCall();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      title={state.status === "connected" ? "Disconnect Tailscale?" : "Stop connecting Tailscale?"}
      description="Agents lose the tailnet at once, and so do the custom MCPs on it."
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              call("tailnet_disconnect", noInput).then(
                () => {
                  void tailnet.reread();
                  onClose();
                },
                (e: unknown) => {
                  setBusy(false);
                  setProblem(errorText(e));
                },
              );
            }}
          >
            {busy ? "Disconnecting…" : "Disconnect"}
          </Button>
        </>
      }
    >
      <Problem text={problem} />
    </Dialog>
  );
}

