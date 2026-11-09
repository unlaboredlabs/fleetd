// A project's MCP servers (its Project page, its one list of them): the ones the person connects to its lead, judged by
// the hub's policy, and the ones its agents get too, by roles and unasked (edited with McpServers' editor). Connecting seals the
// key in main to the project's machine and saves it (mcp_server_set), then tests it at once
// (mcp_server_test), which lists each tool by the hub's policy: runs without asking, asks each time, never. A server
// that wants the person to sign in instead (OAuth) opens its own sign-in page in the browser (mcp_oauth_start), which
// sends them back to the hub; the dialog follows the server's sign-in until it is done, then tests it. A signed-out
// server shows why, with Reconnect. Disconnect is mcp_server_remove, which also erases the key on the machine.
import { useEffect, useEffectEvent, useState, type ReactNode } from "react";
import { Button, Checkbox, Dialog, Field, Input, Radio, RadioGroup, Switch, Text, Textarea, Truncate } from "../../ui";
import type { McpOauthStartOutput, McpServer, McpTestResult } from "../../../shared/contracts";
import type { McpServerRequest } from "../../../shared/ipc";
import { CallError } from "../../src/data/queries";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import {
  byPolicy,
  customRequest,
  DOCS,
  emptyNote,
  hostOf,
  markOf,
  policyLine,
  signInLine,
  signInOutcome,
  statusOf,
  suggestedReads,
  testProblem,
  type SignInMark,
} from "./integrationsModel";
import { emptyDraft, globalsFor, nameProblem, rolesText, type Draft } from "./mcpModel";
import { ServerEditor } from "./McpServers";
import { CommandLine, Prose } from "../onboarding/Prose";
import { AddButton, SettingsList, SettingsListRow, SettingsRow } from "./parts";
import { Plug } from "lucide-react";
import s from "./settings.module.css";
import { boxOf } from "./claudeModel";

type Ref = { machineId: string; projectId: string };
type Tested = { machineId: string; result: McpTestResult } | { error: string };

const open = (url: string): void => void window.fleetd.openExternal(url);

function useMachine(ref: Ref): { name: string; boxes: McpServerRequest["boxes"] } {
  const m = useData((d) => d.machines[ref.machineId]);
  const box = boxOf(m);
  return {
    name: m?.name ?? ref.machineId,
    boxes: box === undefined ? [] : [{ machineId: ref.machineId, boxPubKey: box }],
  };
}

/** Saves through main (which seals the secrets) and tests at once; the saved server's name, or why not. */
function useConnect() {
  const { hub } = useDataLayer();
  const hubCall = useHubCall();
  const refetch = useRefetch();
  return async (request: McpServerRequest): Promise<{ ok: true; tested: Tested } | { ok: false; problem: string }> => {
    const out = await window.fleetd.secret.mcpServer(hub, request).catch((e: unknown) => ({ ok: false as const, problem: errorText(e) }));
    if (!out.ok) return { ok: false, problem: "problem" in out ? out.problem : errorText(new CallError(out.error)) };
    refetch(["mcp_servers_get", "setup_list"]);
    const tested = await hubCall("mcp_server_test", { scope: request.scope, name: request.name }).then(
      (t): Tested => ({ machineId: t.machineId, result: t.result }),
      (e: unknown): Tested => ({ error: errorText(e) }),
    );
    return { ok: true, tested };
  };
}

type Dialogs = { kind: "custom" } | { kind: "edit"; server: McpServer } | { kind: "disconnect"; server: McpServer } | { kind: "signin"; server: McpServer };

/** Whether a test says the server wants the person to sign in. */
const wantsSignIn = (t: Tested | null | undefined): boolean => t !== null && t !== undefined && !("error" in t) && t.result.signIn === true;

type SignInPhase =
  | { readonly kind: "ready" }
  | { readonly kind: "starting" }
  /** The service lets no app register itself: the person's own OAuth app, allowing `redirectUri`. */
  | { readonly kind: "client"; readonly redirectUri: string; readonly issuer: string; readonly boxPubKey: string }
  /** Its sign-in page is open in the browser. */
  | { readonly kind: "waiting"; readonly authorizeUrl: string; readonly mark: SignInMark }
  /** The hub has the tokens: the server is tested next. */
  | { readonly kind: "connected" };

/**
 * A sign-in to a saved server, from the button to its end: mcp_oauth_start (or the person's own app, sealed in main),
 * the service's page opened in the browser, then the server's sign-in followed until the hub has the tokens.
 */
function useSignIn(projectRef: Ref, name: string, onSignedIn: () => void) {
  const { hub } = useDataLayer();
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const live = useLive();
  // Where this app reaches the hub: the service sends the browser back there.
  const appUrl = useData((st) => (st.hub.phase === "unpaired" ? undefined : st.hub.hub));
  const read = useToolQuery("mcp_servers_get", { project: projectRef }, { enabled: live });
  const oauth = (read.data?.project ?? []).find((x) => x.name === name)?.oauth;
  const [phase, setPhase] = useState<SignInPhase>({ kind: "ready" });
  const [problem, setProblem] = useState<string | null>(null);
  const scope = { kind: "project" as const, ...projectRef };
  const hubUrl = appUrl === undefined ? {} : { hubUrl: appUrl.includes("://") ? appUrl : `http://${appUrl}` };
  const opened = (out: McpOauthStartOutput) => {
    if (out.authorizeUrl !== undefined) {
      const url = out.authorizeUrl;
      setPhase({ kind: "waiting", authorizeUrl: url, mark: markOf(oauth) });
      refetch(["mcp_servers_get"]);
      void window.fleetd.openExternal(url).then((o) => {
        if (!o.ok) setProblem(o.message);
      });
    } else if (out.needsClient !== undefined) {
      setPhase({ kind: "client", redirectUri: out.redirectUri, issuer: out.needsClient.issuer, boxPubKey: out.needsClient.boxPubKey });
    }
  };
  const failed = (e: unknown, back: SignInPhase) => {
    setPhase(back);
    setProblem(errorText(e));
  };
  const begin = () => {
    setPhase({ kind: "starting" });
    setProblem(null);
    hubCall("mcp_oauth_start", { scope, name, ...hubUrl }).then(opened, (e: unknown) => failed(e, { kind: "ready" }));
  };
  const withClient = (clientId: string, clientSecret: string) => {
    if (phase.kind !== "client") return;
    const back = phase;
    setPhase({ kind: "starting" });
    setProblem(null);
    void window.fleetd.secret
      .mcpOauthClient(hub, { scope, name, ...hubUrl, boxPubKey: back.boxPubKey, clientId, clientSecret })
      .then((out) => (out.ok ? opened(out.output as McpOauthStartOutput) : failed(new CallError(out.error), back)), (e: unknown) => failed(e, back));
  };
  // The server's sign-in as the hub has it moves this one on, while rendering.
  if (phase.kind === "waiting") {
    const outcome = signInOutcome(oauth, phase.mark);
    if (outcome.kind === "connected") setPhase({ kind: "connected" });
    else if (outcome.kind === "failed") {
      setPhase({ kind: "ready" });
      setProblem(outcome.problem);
    } else if (outcome.mark !== phase.mark) setPhase({ ...phase, mark: outcome.mark });
  }
  const signedIn = useEffectEvent(onSignedIn);
  useEffect(() => {
    if (phase.kind === "connected") signedIn();
  }, [phase.kind]);
  return { phase, problem, oauth, begin, withClient };
}

type SignIn = ReturnType<typeof useSignIn>;

/** What the sign-in shows: why it signs in, the person's own app's fields, or that the browser is open. */
function SignInBody({
  signIn,
  url,
  why,
  client,
  setClient,
}: {
  signIn: SignIn;
  url: string;
  /** Why it is signed out, before it is signed in again. */
  why?: string | undefined;
  client: { id: string; secret: string };
  setClient: (c: { id: string; secret: string }) => void;
}) {
  const { phase } = signIn;
  if (phase.kind === "connected") {
    return (
      <div role="status">
        <Text size="sm">Signed in. Testing the connection…</Text>
      </div>
    );
  }
  if (phase.kind === "waiting") {
    return (
      <div className={s.stack}>
        <div role="status">
          <Prose size="sm" text={`Finish signing in on ${hostOf(signIn.oauth?.issuer ?? url)}'s page in your browser. This moves on by itself once you're done.`} />
        </div>
        <div className={s.inline}>
          <Button size="sm" variant="ghost" onClick={() => open(phase.authorizeUrl)}>
            Open the sign-in page again
          </Button>
        </div>
        <Problem text={signIn.problem} />
      </div>
    );
  }
  if (phase.kind === "client") {
    const host = hostOf(phase.issuer);
    return (
      <div className={s.stack}>
        <Prose
          size="sm"
          text={`${host} doesn't let apps sign up by themselves, so sign in through an OAuth app of your own. Make one in ${host}'s developer settings, allow the redirect URL below, then enter its client ID and secret.`}
        />
        <section className={s.stack} aria-label="Redirect URL">
          <Text size="sm" strong>
            Redirect URL
          </Text>
          <CommandLine command={phase.redirectUri} />
          <Text size="xs" tone="quiet">
            Paste it into your app exactly as it is.
          </Text>
        </section>
        <Field label="Client ID">
          <Input mono aria-label="Client ID" value={client.id} autoComplete="off" spellCheck={false} onChange={(e) => setClient({ ...client, id: e.target.value })} />
        </Field>
        <Field label="Client secret (optional)">
          <Input mono aria-label="Client secret" className={s.secretValue} data-secret="" value={client.secret} autoComplete="off" spellCheck={false} onChange={(e) => setClient({ ...client, secret: e.target.value })} />
        </Field>
        <Text size="xs" tone="quiet">
          The secret is encrypted on this computer so only the hub can read it. fleetd never shows it again, and it never goes in the chat.
        </Text>
        <Problem text={signIn.problem} />
      </div>
    );
  }
  return (
    <div className={s.stack}>
      {why === undefined ? null : <Prose size="sm" tone="danger" text={why} />}
      <Prose
        size="sm"
        text={`Your browser opens ${hostOf(url)}'s own sign-in page. Sign in with your account there and allow fleetd; you come back here once it's done. fleetd keeps the sign-in fresh by itself, and it never goes in the chat.`}
      />
      <Problem text={signIn.problem} />
    </div>
  );
}

function SignInFooter({ signIn, client, onCancel }: { signIn: SignIn; client: { id: string; secret: string }; onCancel: () => void }) {
  const { phase } = signIn;
  const busy = phase.kind === "starting" || phase.kind === "connected";
  return (
    <>
      <Button onClick={onCancel} disabled={busy}>
        {phase.kind === "waiting" ? "Stop waiting" : "Not now"}
      </Button>
      {phase.kind === "waiting" ? null : phase.kind === "connected" ? (
        <Button variant="primary" disabled>
          Testing…
        </Button>
      ) : phase.kind === "client" ? (
        <Button variant="primary" disabled={client.id.trim() === ""} onClick={() => signIn.withClient(client.id, client.secret)}>
          Sign in
        </Button>
      ) : (
        <Button variant="primary" disabled={busy} onClick={signIn.begin}>
          {busy ? "Opening…" : "Sign in"}
        </Button>
      )}
    </>
  );
}

/** Reconnect (or a first sign-in) from the list: signs in, then tests the server and shows what it found in its row. */
function SignInDialog(props: { projectRef: Ref; server: McpServer; onClose: () => void; onTested: (name: string, t: Tested) => void }) {
  const hubCall = useHubCall();
  const { server } = props;
  const [client, setClient] = useState({ id: "", secret: "" });
  const signIn = useSignIn(props.projectRef, server.name, () => {
    hubCall("mcp_server_test", { scope: server.scope, name: server.name }).then(
      (out) => props.onTested(server.name, { machineId: out.machineId, result: out.result }),
      (e: unknown) => props.onTested(server.name, { error: errorText(e) }),
    );
    props.onClose();
  });
  const url = server.transport.type === "stdio" ? "" : server.transport.url;
  const again = server.oauth?.signedInAt !== undefined;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && signIn.phase.kind !== "starting" && props.onClose()}
      title={again ? `Reconnect ${server.name}` : `Sign in to ${server.name}`}
      footer={<SignInFooter signIn={signIn} client={client} onCancel={props.onClose} />}
    >
      <SignInBody signIn={signIn} url={url} why={server.oauth?.problem} client={client} setClient={setClient} />
    </Dialog>
  );
}

/**
 * A project's one MCP servers list: what the lead reaches for it (its integrations, judged by the hub's policy, with
 * their sign-ins), what its agents get too (by roles, unjudged), and the hub's servers for every project.
 */
export function McpServersSection({ projectRef }: { projectRef: Ref }) {
  const live = useLive();
  const read = useToolQuery("mcp_servers_get", { project: projectRef }, { enabled: live });
  const [dialog, setDialog] = useState<Dialogs | null>(null);
  const [tests, setTests] = useState<Readonly<Record<string, Tested>>>({});
  const machine = useMachine(projectRef);
  const help = "Tools the lead reaches for you. Reads run unasked; anything else follows Approvals.";
  if (!live || read.data === undefined) {
    return (
      <SettingsRow
        reveal="projects.mcp"
        title="MCP servers"
        line={!live ? "Not connected. Connect to a hub to change its MCP servers." : read.isLoadingError ? errorText(read.error) : "Loading…"}
        lineTone={read.isLoadingError ? "danger" : "quiet"}
      />
    );
  }
  const all = read.data.project ?? [];
  const globals = globalsFor(read.data.global, all);
  const tested = (name: string, t: Tested) => setTests((list) => ({ ...list, [name]: t }));
  const done = (name: string) => (t: Tested) => {
    tested(name, t);
    setDialog(null);
  };
  return (
    <SettingsRow
      reveal="projects.mcp"
      title="MCP servers"
      line={help}
      control={
        <>
          <Button variant="ghost" onClick={() => open(DOCS)}>
            How they work
          </Button>
          <AddButton label="Add an MCP server" onClick={() => setDialog({ kind: "custom" })} />
        </>
      }
    >
      {all.length === 0 ? null : (
        <SettingsList label="MCP servers">
        {all.map((server) => (
          <Row
            key={server.name}
            title={server.name}
            what={server.transport.type === "stdio" ? [server.transport.command, ...(server.transport.args ?? [])].join(" ") : server.transport.url}
            server={server}
            machine={machine.name}
            tested={tests[server.name]}
            onTested={tested}
            onEdit={(s2) => setDialog({ kind: "edit", server: s2 })}
            onDisconnect={(s2) => setDialog({ kind: "disconnect", server: s2 })}
            onSignIn={(s2) => setDialog({ kind: "signin", server: s2 })}
          />
        ))}
        </SettingsList>
      )}
      {globals.length > 0 ? (
        <div className={s.stack}>
          <Text size="xs" tone="quiet">
            For every project, from Hub › Every project › Tools &amp; skills:
          </Text>
          {globals.map(({ server, replaced }) => (
            <Text key={server.name} size="sm" tone="quiet">
              <Text as="span" mono size="sm">
                {server.name}
              </Text>{" "}
              {replaced ? "· replaced by this project's" : server.enabled ? `· ${rolesText(server.roles)}` : "· off"}
            </Text>
          ))}
        </div>
      ) : null}
      {dialog?.kind === "custom" ? <ConnectCustom projectRef={projectRef} taken={all.map((x) => x.name)} onClose={() => setDialog(null)} onDone={(name, t) => done(name)(t)} /> : null}
      {dialog?.kind === "edit" ? (
        <ServerEditor scope={projectRef} editing={dialog.server} taken={all.map((x) => x.name)} onClose={() => setDialog(null)} onSaved={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === "disconnect" ? <Disconnect server={dialog.server} machine={machine.name} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === "signin" ? <SignInDialog projectRef={projectRef} server={dialog.server} onClose={() => setDialog(null)} onTested={tested} /> : null}
    </SettingsRow>
  );
}

function Row(props: {
  title: string;
  what: string;
  server: McpServer;
  machine: string;
  tested: Tested | undefined;
  onTested: (name: string, t: Tested) => void;
  onEdit: (server: McpServer) => void;
  onDisconnect: (server: McpServer) => void;
  onSignIn: (server: McpServer) => void;
}) {
  const hubCall = useHubCall();
  const [testing, setTesting] = useState(false);
  const { server } = props;
  // One the project's agents get too: its roles stand for its policy, since every tool runs unasked.
  const agents = server.integration === undefined;
  const test = (sv: McpServer) => {
    setTesting(true);
    hubCall("mcp_server_test", { scope: sv.scope, name: sv.name }).then(
      (out) => {
        setTesting(false);
        props.onTested(sv.name, { machineId: out.machineId, result: out.result });
      },
      (e: unknown) => {
        setTesting(false);
        props.onTested(sv.name, { error: errorText(e) });
      },
    );
  };
  const sealed = [...(server.env ?? []), ...(server.headers ?? [])].some((v) => v.kind === "secret" && (v.sealedOn ?? []).length > 0);
  const status = statusOf(server);
  const line = server.oauth === undefined ? null : signInLine(server.oauth);
  // Signed out, or its test found it wants a sign-in: the way back is right on the row.
  const signIn = (server.oauth?.status === "signed_out" && server.oauth.signingIn !== true) || wantsSignIn(props.tested);
  return (
    <SettingsListRow
      label={props.title}
      icon={<Plug />}
      name={props.title}
      state={{ word: agents && server.enabled ? `${rolesText(server.roles)} · unasked` : status.text, tone: status.tone }}
      controls={
        <>
          {signIn ? (
            <Button variant="primary" onClick={() => props.onSignIn(server)}>
              {server.oauth?.signedInAt === undefined ? "Sign in" : "Reconnect"}
            </Button>
          ) : null}
          <Button variant="ghost" disabled={testing} onClick={() => test(server)}>
            {testing ? "Testing…" : "Test"}
          </Button>
          {agents ? (
            <Button variant="ghost" onClick={() => props.onEdit(server)}>
              Edit
            </Button>
          ) : null}
          <Button variant="ghost" onClick={() => props.onDisconnect(server)}>
            Disconnect
          </Button>
        </>
      }
    >
      <Truncate size="sm" tone="quiet">
        {props.what}
      </Truncate>
      {line !== null ? (
        <Prose size="sm" tone={line.tone === "quiet" ? "quiet" : "danger"} text={line.text} />
      ) : sealed ? (
        <Text size="sm" tone="quiet">
          Key sealed on {props.machine}. It never goes in the chat.
        </Text>
      ) : null}
      {props.tested === undefined ? null : <Found tested={props.tested} machine={props.machine} brief={agents} />}
    </SettingsListRow>
  );
}

/** What a test found: the tools by policy, or the failure. `brief`: only where it worked, above the tools to tick. */
function Found(props: { tested: Tested; machine: string; brief?: boolean }) {
  const { tested } = props;
  if ("error" in tested || tested.result.error !== undefined) {
    const error = "error" in tested ? tested.error : (tested.result.error ?? "");
    return (
      <div role="alert">
        <Prose size="sm" tone="danger" text={testProblem(error, props.machine, wantsSignIn(tested))} />
      </div>
    );
  }
  const empty = emptyNote(tested.result);
  if (empty !== null) {
    return (
      <div role="status">
        <Text size="sm" tone="warning">
          {empty}
        </Text>
      </div>
    );
  }
  const works = `Works on ${tested.machineId}${tested.result.server === undefined ? "" : ` (${tested.result.server})`}`;
  if (props.brief === true) {
    return (
      <div role="status">
        <Text size="sm">{`${works}.`}</Text>
      </div>
    );
  }
  const p = byPolicy(tested.result.tools ?? []);
  const list = (label: string, names: ReadonlyArray<string>): ReactNode =>
    names.length === 0 ? null : (
      <div className={s.policyRow}>
        <Text size="xs" tone="quiet">
          {label}
        </Text>
        <Truncate size="xs" mono tone="quiet">
          {names.join(", ")}
        </Truncate>
      </div>
    );
  return (
    <div role="status" className={s.stack}>
      <Text size="sm">{`${works}: ${policyLine(p)}.`}</Text>
      <div className={s.policy}>
        {list("Without asking", p.read)}
        {list("Asks you", p.ask)}
        {list("Never", p.blocked)}
      </div>
    </div>
  );
}

function ConnectFooter(props: { busy: boolean; ok: boolean; label: string; onClose: () => void; onConnect: () => void }) {
  return (
    <>
      <Button onClick={props.onClose} disabled={props.busy}>
        Cancel
      </Button>
      <Button variant="primary" disabled={props.busy || !props.ok} onClick={props.onConnect}>
        {props.busy ? "Connecting…" : props.label}
      </Button>
    </>
  );
}

function SealedNote({ machine, what }: { machine: string; what: string }) {
  return (
    <Text size="xs" tone="quiet">
      {`The ${what} is encrypted on this computer so only ${machine} can read it. fleetd never shows it again, and it never goes in the chat.`}
    </Text>
  );
}

/** An MCP server: its details, then, once tested, which of its tools only read and may run unasked. */
function ConnectCustom(props: { projectRef: Ref; taken: ReadonlyArray<string>; onClose: () => void; onDone: (name: string, t: Tested) => void }) {
  const machine = useMachine(props.projectRef);
  // The project by its name, as the person calls it: "Which of mail's tools may Ada use without asking?"
  const who = useData((d) => d.projects[`${props.projectRef.machineId}/${props.projectRef.projectId}`]?.title) ?? "Its lead";
  const connect = useConnect();
  const scope = { kind: "project" as const, ...props.projectRef };
  const [draft, setDraft] = useState<Draft>(() => ({ ...emptyDraft(), kind: "http", values: [{ name: "Authorization", secret: true, value: "", saved: false }] }));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [tested, setTested] = useState<Tested | null>(null);
  const [reads, setReads] = useState<ReadonlySet<string>>(new Set());
  const [client, setClient] = useState({ id: "", secret: "" });
  const [agents, setAgents] = useState(false);
  const hubCall = useHubCall();
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const value = draft.values[0] ?? { name: "", secret: true, value: "", saved: false };
  const setValue = (patch: Partial<typeof value>) => set({ values: [{ ...value, ...patch }] });
  // An empty key is no key: the server takes none.
  const withKey: Draft = value.value === "" && !value.saved ? { ...draft, values: [] } : draft;
  const built = customRequest(withKey, [...reads], scope, machine.boxes, agents);
  const nameIssue = tested === null ? nameProblem(draft.name.trim(), props.taken) : null;
  const stdio = draft.kind === "stdio";
  const first = () => {
    if (!built.ok) return;
    setBusy(true);
    setProblem(null);
    void connect(built.request).then((out) => {
      setBusy(false);
      if (!out.ok) {
        setProblem(out.problem);
        return;
      }
      // Its agents get it too: every tool runs unasked, so there are none to pick.
      if (agents && !wantsSignIn(out.tested)) {
        props.onDone(built.request.name, out.tested);
        return;
      }
      setTested(out.tested);
      if (!("error" in out.tested)) setReads(new Set(suggestedReads(out.tested.result.tools ?? [])));
      // Saved: its key is kept as it is from now on.
      if (value.value !== "") setValue({ value: "", saved: true });
    });
  };
  const second = () => {
    if (!built.ok || tested === null) return;
    setBusy(true);
    setProblem(null);
    void connect(built.request).then((out) => {
      setBusy(false);
      if (out.ok) props.onDone(built.request.name, out.tested);
      else setProblem(out.problem);
    });
  };
  const tools = tested !== null && !("error" in tested) ? (tested.result.tools ?? []) : [];
  const failed = tested !== null && ("error" in tested || tested.result.error !== undefined);
  const name = draft.name.trim();
  // Signed in: test it now, and go on to its tools as a keyed server does.
  const signIn = useSignIn(props.projectRef, name, () => {
    hubCall("mcp_server_test", { scope, name }).then(
      (t) => {
        setTested({ machineId: t.machineId, result: t.result });
        setReads(new Set(suggestedReads(t.result.tools ?? [])));
      },
      (e: unknown) => setTested({ error: errorText(e) }),
    );
  });
  if (tested !== null && wantsSignIn(tested)) {
    return (
      <Dialog
        open
        wide
        onOpenChange={(o) => !o && signIn.phase.kind !== "starting" && props.onDone(name, tested)}
        title={`Sign in to ${name}`}
        description={`${name} uses your own account with its service instead of a key.`}
        footer={<SignInFooter signIn={signIn} client={client} onCancel={() => props.onDone(name, tested)} />}
      >
        <SignInBody signIn={signIn} url={draft.url} client={client} setClient={setClient} />
      </Dialog>
    );
  }
  return (
    <Dialog
      open
      wide
      onOpenChange={(o) => !o && !busy && (tested === null ? props.onClose() : props.onDone(name, tested))}
      title={tested === null ? "Add an MCP server" : failed ? `${name} is added, but its test failed` : `Which of ${name}'s tools may ${who} use without asking?`}
      description={
        tested === null
          ? `Any MCP server, by its URL or a command run on ${machine.name}.`
          : failed
            ? `${who} can't use it until it works. Test it again from the list; to change its URL or key, disconnect it and add it again.`
            : `Tick the ones that only look things up. Leave anything that changes, sends or deletes unticked, so ${who} asks you each time. Moving money, trading and creating accounts are always blocked.`
      }
      footer={
        tested === null ? (
          <ConnectFooter busy={busy} ok={built.ok && nameIssue === null} label="Connect and test" onClose={props.onClose} onConnect={first} />
        ) : failed ? (
          <Button variant="primary" onClick={() => props.onDone(name, tested)}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={() => props.onDone(name, tested)} disabled={busy}>
              Keep every tool asking
            </Button>
            <Button variant="primary" disabled={busy || !built.ok} onClick={second}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </>
        )
      }
    >
      {tested === null ? (
        <div className={s.stack}>
          <Field label="Name" error={nameIssue} description={`Short: ${who} sees its tools as mcp__<name>__<tool>.`}>
            <Input mono aria-label="Name" value={draft.name} disabled={busy} autoComplete="off" spellCheck={false} placeholder="linear" onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <RadioGroup
            className={s.radios}
            value={draft.kind}
            onValueChange={(v) => set({ kind: v === "stdio" ? "stdio" : "http", values: [{ name: v === "stdio" ? "API_KEY" : "Authorization", secret: true, value: "", saved: false }] })}
            aria-label={`How ${who} reaches it`}
          >
            <Radio value="http" label="URL" />
            <Radio value="stdio" label="Command" />
          </RadioGroup>
          {stdio ? (
            <>
              <Field label="Command" description={`Started on ${machine.name}.`}>
                <Input mono aria-label="Command" value={draft.command} disabled={busy} spellCheck={false} placeholder="npx" onChange={(e) => set({ command: e.target.value })} />
              </Field>
              <Field label="Arguments" description="One per line.">
                <Textarea mono aria-label="Arguments" value={draft.args} minRows={1} maxRows={6} disabled={busy} spellCheck={false} placeholder={"-y\n@acme/mcp-server"} onChange={(e) => set({ args: e.target.value })} />
              </Field>
            </>
          ) : (
            <Field label="URL">
              <Input mono aria-label="URL" value={draft.url} disabled={busy} spellCheck={false} placeholder="https://mcp.example.com/mcp" onChange={(e) => set({ url: e.target.value })} />
            </Field>
          )}
          <div className={s.inline}>
            <Field label={stdio ? "Variable" : "Header"}>
              <Input mono aria-label={stdio ? "Variable" : "Header"} value={value.name} disabled={busy} spellCheck={false} onChange={(e) => setValue({ name: e.target.value })} />
            </Field>
            <Field label="Key (optional)">
              <Input mono aria-label="Key" className={s.secretValue} data-secret="" value={value.value} disabled={busy} autoComplete="off" spellCheck={false} placeholder={stdio ? "" : "Bearer …"} onChange={(e) => setValue({ value: e.target.value })} />
            </Field>
          </div>
          <SealedNote machine={machine.name} what="key" />
          <Switch
            label="Agents get it too"
            description={agents ? "Its writers and reviewers get it as well, and none of its tools asks you: agents can't stop to ask." : `Only ${who} gets it, and asks you before a tool that changes anything.`}
            checked={agents}
            disabled={busy}
            onCheckedChange={setAgents}
          />
          {stdio ? null : (
            <Text size="xs" tone="quiet">
              No key? Leave it empty for a service you sign in to with your account: fleetd opens its sign-in page next.
            </Text>
          )}
          {!built.ok && name !== "" && nameIssue === null ? (
            <Text size="sm" tone="quiet">
              {built.problem}
            </Text>
          ) : null}
          <Problem text={problem} />
        </div>
      ) : (
        <div className={s.stack}>
          <Found tested={tested} machine={machine.name} brief />
          {tools.map((t) => (
            <Checkbox
              key={t.name}
              label={t.name}
              description={t.policy === "blocked" ? "Blocked: fleetd never runs this one." : (t.description ?? (t.readOnly === true ? "The server says it only looks things up." : undefined))}
              checked={reads.has(t.name)}
              disabled={busy || t.policy === "blocked"}
              onCheckedChange={(on) => {
                const next = new Set(reads);
                if (on === true) next.add(t.name);
                else next.delete(t.name);
                setReads(next);
              }}
            />
          ))}
          <Problem text={problem} />
        </div>
      )}
    </Dialog>
  );
}

function Disconnect(props: { server: McpServer; machine: string; onClose: () => void }) {
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const name = props.server.name;
  const source = "To cut it off at the source too, revoke the key where you made it.";
  const go = () => {
    setBusy(true);
    setProblem(null);
    hubCall("mcp_server_remove", { scope: props.server.scope, name: props.server.name }).then(
      () => {
        setBusy(false);
        refetch(["mcp_servers_get", "setup_list"]);
        props.onClose();
      },
      (e: unknown) => {
        setBusy(false);
        setProblem(errorText(e));
      },
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && props.onClose()}
      title={`Disconnect ${name}?`}
      description={`The lead starts without it from its next message, and the key is erased from ${props.machine}. ${source}`}
      footer={
        <>
          <Button onClick={props.onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy} onClick={go}>
            {busy ? "Disconnecting…" : "Disconnect"}
          </Button>
        </>
      }
    >
      <Problem text={problem} />
    </Dialog>
  );
}

function Problem({ text }: { text: string | null }) {
  if (text === null) return null;
  return (
    <div role="alert">
      <Prose tone="danger" text={text} />
    </div>
  );
}
