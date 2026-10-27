// A Navi's Integrations (its Projects page, only for a project of kind assistant): Notion through its official server
// with the person's own integration token, and any other MCP server. Each is one of the Navi's MCP servers:
// connecting seals the token or key in main to Navi's machine and saves it (mcp_server_set), then tests it at once
// (mcp_server_test), which lists each tool by the hub's policy: read freely, ask each time, never. Disconnect is
// mcp_server_remove, which also erases the key on the machine. Google is fleetd's own, connected where it is built.
import { useState, type ReactNode } from "react";
import { Button, Checkbox, Dialog, Field, InlineCode, Input, Radio, RadioGroup, Text, Textarea, Truncate } from "../../ui";
import type { IntegrationKind, McpServer, McpTestResult } from "../../../shared/contracts";
import type { McpServerRequest } from "../../../shared/ipc";
import { CallError } from "../../src/data/queries";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import { byPolicy, connectionsOf, customRequest, DOCS, emptyNote, notionRequest, policyLine, suggestedReads, testProblem } from "./integrationsModel";
import { emptyDraft, nameProblem, type Draft } from "./mcpModel";
import { Setting } from "./parts";
import s from "./settings.module.css";

type Ref = { machineId: string; projectId: string };
type Tested = { machineId: string; result: McpTestResult } | { error: string };

const open = (url: string): void => void window.fleetd.openExternal(url);

function useMachine(ref: Ref): { name: string; boxes: McpServerRequest["boxes"] } {
  const m = useData((d) => d.machines[ref.machineId]);
  return {
    name: m?.name ?? ref.machineId,
    boxes: typeof m?.boxPubKey === "string" ? [{ machineId: ref.machineId, boxPubKey: m.boxPubKey }] : [],
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
    refetch(["mcp_servers_get"]);
    const tested = await hubCall("mcp_server_test", { scope: request.scope, name: request.name }).then(
      (t): Tested => ({ machineId: t.machineId, result: t.result }),
      (e: unknown): Tested => ({ error: errorText(e) }),
    );
    return { ok: true, tested };
  };
}

type Dialogs = { kind: "notion" } | { kind: "custom" } | { kind: "disconnect"; server: McpServer };

export function IntegrationsSection({ projectRef }: { projectRef: Ref }) {
  const live = useLive();
  const read = useToolQuery("mcp_servers_get", { project: projectRef }, { enabled: live });
  const [dialog, setDialog] = useState<Dialogs | null>(null);
  const [tests, setTests] = useState<Readonly<Record<string, Tested>>>({});
  const machine = useMachine(projectRef);
  const help =
    "What Navi reaches for you. Reads run unasked; anything that writes, sends, deletes or shares asks you in the chat first, every time, showing exactly what it would send. Moving money, trading and creating accounts are never allowed.";
  if (!live || read.data === undefined) {
    return (
      <Setting reveal="projects.integrations" label="Integrations" help={help}>
        <Text size="sm" tone={read.isLoadingError ? "danger" : "quiet"}>
          {!live ? "Not connected. Connect to a hub to change Navi's integrations." : read.isLoadingError ? errorText(read.error) : "Loading…"}
        </Text>
      </Setting>
    );
  }
  const c = connectionsOf(read.data.project ?? []);
  const tested = (name: string, t: Tested) => setTests((all) => ({ ...all, [name]: t }));
  const done = (name: string) => (t: Tested) => {
    tested(name, t);
    setDialog(null);
  };
  return (
    <Setting reveal="projects.integrations" label="Integrations" help={help}>
      <div role="list" aria-label="Integrations" className={s.integrations}>
        <Row
          kind="notion"
          title="Notion"
          what="The pages you share with your own Notion integration."
          server={c.notion}
          machine={machine.name}
          tested={c.notion === undefined ? undefined : tests[c.notion.name]}
          onTested={tested}
          onConnect={() => setDialog({ kind: "notion" })}
          onDisconnect={(server) => setDialog({ kind: "disconnect", server })}
        />
        {c.custom.map((server) => (
          <Row
            key={server.name}
            kind="custom"
            title={server.name}
            what={server.transport.type === "stdio" ? [server.transport.command, ...(server.transport.args ?? [])].join(" ") : server.transport.url}
            server={server}
            machine={machine.name}
            tested={tests[server.name]}
            onTested={tested}
            onConnect={() => undefined}
            onDisconnect={(s2) => setDialog({ kind: "disconnect", server: s2 })}
          />
        ))}
      </div>
      <div className={s.inline}>
        <Button onClick={() => setDialog({ kind: "custom" })}>Add an MCP server</Button>
        <Button variant="ghost" onClick={() => open(DOCS)}>
          How integrations work
        </Button>
      </div>
      {dialog?.kind === "notion" ? <ConnectNotion projectRef={projectRef} onClose={() => setDialog(null)} onDone={done("notion")} /> : null}
      {dialog?.kind === "custom" ? (
        <ConnectCustom projectRef={projectRef} taken={(read.data.project ?? []).map((x) => x.name)} onClose={() => setDialog(null)} onDone={(name, t) => done(name)(t)} />
      ) : null}
      {dialog?.kind === "disconnect" ? <Disconnect server={dialog.server} machine={machine.name} onClose={() => setDialog(null)} /> : null}
    </Setting>
  );
}

function Row(props: {
  kind: IntegrationKind;
  title: string;
  what: string;
  server: McpServer | undefined;
  machine: string;
  tested: Tested | undefined;
  onTested: (name: string, t: Tested) => void;
  onConnect: () => void;
  onDisconnect: (server: McpServer) => void;
}) {
  const hubCall = useHubCall();
  const [testing, setTesting] = useState(false);
  const { server } = props;
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
  const sealed = server === undefined ? false : [...(server.env ?? []), ...(server.headers ?? [])].some((v) => v.kind === "secret" && (v.sealedOn ?? []).length > 0);
  return (
    <div role="listitem" aria-label={props.title} className={s.integration} data-connected={server === undefined ? undefined : ""}>
      <div className={s.integrationHead}>
        <div className={s.stack}>
          <Text strong size="sm">
            {props.title}
          </Text>
          <Truncate size="xs" tone="quiet">
            {props.what}
          </Truncate>
        </div>
        <div className={s.inline}>
          {server === undefined ? (
            <Button size="sm" onClick={props.onConnect}>
              Connect
            </Button>
          ) : (
            <>
              <Text size="xs" tone="quiet">
                {server.enabled ? "Connected" : "Off"}
              </Text>
              <Button size="sm" variant="ghost" disabled={testing} onClick={() => test(server)}>
                {testing ? "Testing…" : "Test connection"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => props.onDisconnect(server)}>
                Disconnect
              </Button>
            </>
          )}
        </div>
      </div>
      {server !== undefined && sealed ? (
        <Text size="xs" tone="quiet">
          {props.kind === "notion" ? "Integration secret" : "Key"} sealed on {props.machine}. Navi never sees it.
        </Text>
      ) : null}
      {props.tested === undefined ? null : <Found kind={props.kind} tested={props.tested} machine={props.machine} />}
    </div>
  );
}

/** What a test found: the tools by policy, or the failure in the integration's words. */
function Found(props: { kind: IntegrationKind; tested: Tested; machine: string }) {
  const { tested } = props;
  if ("error" in tested || tested.result.error !== undefined) {
    const error = "error" in tested ? tested.error : (tested.result.error ?? "");
    return (
      <div role="alert">
        <Text size="sm" tone="danger">
          {testProblem(props.kind, error, props.machine)}
        </Text>
      </div>
    );
  }
  const empty = emptyNote(props.kind, tested.result);
  if (empty !== null) {
    return (
      <div role="status">
        <Text size="sm" tone="warning">
          {empty}
        </Text>
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
      <Text size="sm">{`Works on ${tested.machineId}${tested.result.server === undefined ? "" : ` (${tested.result.server})`}: ${policyLine(p)}.`}</Text>
      <div className={s.policy}>
        {list("Reads freely", p.read)}
        {list("Asks you", p.ask)}
        {list("Never", p.blocked)}
      </div>
    </div>
  );
}

/** Numbered steps, each a line or two, with the values to paste in code. */
function Steps({ children }: { children: ReactNode }) {
  return <ol className={s.steps}>{children}</ol>;
}

function Step({ children }: { children: ReactNode }) {
  return (
    <li>
      <Text size="sm">{children}</Text>
    </li>
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
      {`The ${what} is sealed on this computer to ${machine}'s key, so only ${machine} can open it. fleetd never shows it again, and Navi never sees it: it isn't in any chat or transcript.`}
    </Text>
  );
}

function ConnectNotion(props: { projectRef: Ref; onClose: () => void; onDone: (t: Tested) => void }) {
  const machine = useMachine(props.projectRef);
  const connect = useConnect();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const built = notionRequest(token, { kind: "project", ...props.projectRef }, machine.boxes);
  const go = () => {
    if (!built.ok) return;
    setBusy(true);
    setProblem(null);
    void connect(built.request).then((out) => {
      setBusy(false);
      if (out.ok) props.onDone(out.tested);
      else setProblem(out.problem);
    });
  };
  return (
    <Dialog
      open
      wide
      onOpenChange={(o) => !o && !busy && props.onClose()}
      title="Connect Notion"
      description="Navi uses Notion's official MCP server with an integration you make in your own workspace. It sees only the pages you share with that integration."
      footer={<ConnectFooter busy={busy} ok={built.ok} label="Connect and test" onClose={props.onClose} onConnect={go} />}
    >
      <div className={s.stack}>
        <Steps>
          <Step>
            In Notion, open <InlineCode>notion.so/profile/integrations</InlineCode> and make a new integration: Internal, in the workspace Navi should use. Name it Navi.
          </Step>
          <Step>Under Capabilities, keep Read content, Update content and Insert content. Add the comment ones if Navi should comment.</Step>
          <Step>Copy its Internal Integration Secret (it starts with ntn_) and paste it below.</Step>
          <Step>Share pages with it: on each page Navi may use, open the ••• menu, then Connections, and add Navi. Pages under it come along.</Step>
        </Steps>
        <div className={s.inline}>
          <Button size="sm" variant="ghost" onClick={() => open(`${DOCS}#notion`)}>
            Step by step in the docs
          </Button>
        </div>
        <Field label="Integration secret" description={`Notion's server runs on ${machine.name} with npx, which comes with Node.js.`}>
          <Input mono aria-label="Integration secret" className={s.secretValue} data-secret="" value={token} disabled={busy} autoComplete="off" spellCheck={false} placeholder="ntn_…" onChange={(e) => setToken(e.target.value)} />
        </Field>
        <SealedNote machine={machine.name} what="secret" />
        {!built.ok && token.trim() !== "" ? (
          <Text size="sm" tone="quiet">
            {built.problem}
          </Text>
        ) : null}
        <Problem text={problem} />
      </div>
    </Dialog>
  );
}

/** Any other MCP server: its details, then, once tested, which of its tools only read and may run unasked. */
function ConnectCustom(props: { projectRef: Ref; taken: ReadonlyArray<string>; onClose: () => void; onDone: (name: string, t: Tested) => void }) {
  const machine = useMachine(props.projectRef);
  const connect = useConnect();
  const scope = { kind: "project" as const, ...props.projectRef };
  const [draft, setDraft] = useState<Draft>(() => ({ ...emptyDraft(), kind: "http", values: [{ name: "Authorization", secret: true, value: "", saved: false }] }));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [tested, setTested] = useState<Tested | null>(null);
  const [reads, setReads] = useState<ReadonlySet<string>>(new Set());
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const value = draft.values[0] ?? { name: "", secret: true, value: "", saved: false };
  const setValue = (patch: Partial<typeof value>) => set({ values: [{ ...value, ...patch }] });
  // An empty key is no key: the server takes none.
  const withKey: Draft = value.value === "" && !value.saved ? { ...draft, values: [] } : draft;
  const built = customRequest(withKey, [...reads], scope, machine.boxes);
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
  return (
    <Dialog
      open
      wide
      onOpenChange={(o) => !o && !busy && (tested === null ? props.onClose() : props.onDone(draft.name.trim(), tested))}
      title={tested === null ? "Add an MCP server" : `Which of ${draft.name.trim()}'s tools only read?`}
      description={
        tested === null
          ? "Any MCP server, by URL or by a command on Navi's machine. Every one of its tools asks you first until you mark it as one that only reads."
          : "A tool you tick runs without asking. Leave anything that changes, sends or deletes unticked: it asks you each time. Moving money, trading and creating accounts stay blocked."
      }
      footer={
        tested === null ? (
          <ConnectFooter busy={busy} ok={built.ok && nameIssue === null} label="Connect and test" onClose={props.onClose} onConnect={first} />
        ) : (
          <>
            <Button onClick={() => props.onDone(draft.name.trim(), tested)} disabled={busy}>
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
          <Field label="Name" error={nameIssue} description="Short, as Navi sees its tools: mcp__<name>__<tool>.">
            <Input mono aria-label="Name" value={draft.name} disabled={busy} autoComplete="off" spellCheck={false} placeholder="linear" onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <RadioGroup
            className={s.radios}
            value={draft.kind}
            onValueChange={(v) => set({ kind: v === "stdio" ? "stdio" : "http", values: [{ name: v === "stdio" ? "API_KEY" : "Authorization", secret: true, value: "", saved: false }] })}
            aria-label="How Navi reaches it"
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
          {!built.ok && draft.name.trim() !== "" ? (
            <Text size="sm" tone="quiet">
              {built.problem}
            </Text>
          ) : null}
          <Problem text={problem} />
        </div>
      ) : (
        <div className={s.stack}>
          <Found kind="custom" tested={tested} machine={machine.name} />
          {tools.map((t) => (
            <Checkbox
              key={t.name}
              label={t.name}
              description={t.policy === "blocked" ? "Blocked: fleetd never runs this one." : (t.description ?? (t.readOnly === true ? "The server says it only reads." : undefined))}
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
  const kind = props.server.integration?.kind ?? "custom";
  const name = kind === "notion" ? "Notion" : props.server.name;
  const source =
    kind === "notion"
        ? "To cut it off at the source too, delete the integration in Notion (notion.so/profile/integrations)."
        : "To cut it off at the source too, revoke the key where you made it.";
  const go = () => {
    setBusy(true);
    setProblem(null);
    hubCall("mcp_server_remove", { scope: props.server.scope, name: props.server.name }).then(
      () => {
        setBusy(false);
        refetch(["mcp_servers_get"]);
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
      description={`Navi starts without it from its next message, and the key is erased from ${props.machine}. ${source}`}
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
      <Text tone="danger">{text}</Text>
    </div>
  );
}
