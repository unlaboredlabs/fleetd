// MCP servers: HubMcpServers, the ones every project's agents get and whether they also get their own (Administration ›
// Hub settings, owners and admins only, D209); and McpSection, a project's own servers on its Projects page. Reads
// mcp_servers_get; saves through main (mcp_server_set, each secret sealed there to each machine's key), removes with
// mcp_server_remove and tests with mcp_server_test. A secret's value is write-only: typed here once, sealed in main, never shown again.
import { useState } from "react";
import { Button, Checkbox, Dialog, Field, Input, Radio, RadioGroup, Switch, Text, Textarea, Truncate } from "../../ui";
import type { McpRoles, McpScope, McpServer, McpTestResult } from "../../../shared/contracts";
import type { McpServerRequest } from "../../../shared/ipc";
import { CallError } from "../../src/data/queries";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import { draftOf, emptyDraft, globalsFor, missingOn, nameProblem, rolesText, toRequest, transportText, valuesText, type Draft, type DraftValue, type TransportKind } from "./mcpModel";
import { Setting } from "./parts";
import s from "./settings.module.css";

/** When a change reaches agents, said wherever one is saved. */
export const TAKES_EFFECT = "Agents started from now on get it; one already running at its next start, after its next message.";

type Ref = { machineId: string; projectId: string };

const scopeOf = (ref: Ref | null): McpScope => (ref === null ? { kind: "global" } : { kind: "project", ...ref });

/** The box keys a scope's secrets are sealed to: a project's machine, or every machine for a global server. */
function useBoxes(ref: Ref | null): McpServerRequest["boxes"] {
  const machines = useData((d) => d.machines);
  return Object.values(machines)
    .filter((m) => (ref === null || m.machineId === ref.machineId) && typeof m.boxPubKey === "string")
    .map((m) => ({ machineId: m.machineId, boxPubKey: m.boxPubKey as string }));
}

function useMachineIds(): string[] {
  const machines = useData((d) => d.machines);
  return Object.keys(machines).sort();
}

/** Administration › Hub settings: the MCP servers every project's agents get, and whether they also get their own. */
export function HubMcpServers() {
  const live = useLive();
  const read = useToolQuery("mcp_servers_get", {}, { enabled: live });
  if (!live) return <Text tone="quiet">Connect to a hub to see and change this.</Text>;
  const data = read.data;
  return (
    <>
      {read.isLoadingError ? (
        <div className={s.inline}>
          <Text tone="danger">{errorText(read.error)}</Text>
          <Button onClick={() => void read.refetch()}>Try again</Button>
        </div>
      ) : null}
      {data ? (
        <>
          <ServersSetting
            reveal="mcp.servers"
            label="Global MCP servers"
            help="Given to every project's agents of the roles you pick, as commands on their machine or services over HTTP. A project's own replaces one of the same name."
            scope={null}
            servers={data.global}
          />
          <UserServers on={data.userServers} />
        </>
      ) : read.isLoadingError ? null : (
        <Text tone="quiet">Loading…</Text>
      )}
    </>
  );
}

function UserServers({ on }: { on: boolean }) {
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const [busy, setBusy] = useState(false);
  const [echo, setEcho] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <Setting reveal="mcp.user" label="Own MCP servers" help="The servers in the claude setup where an agent runs (~/.claude.json, a repo's .mcp.json).">
      <Switch
        label="Agents also get their own MCP servers"
        description="Off: agents get fleetd's tools and the servers here only. fleetd's own tools are always there."
        checked={on}
        disabled={busy}
        onCheckedChange={(next) => {
          setBusy(true);
          setEcho(null);
          hubCall("mcp_settings_set", { userServers: next }).then(
            () => {
              setBusy(false);
              setEcho({ ok: true, text: `${next ? "On" : "Off"}. ${TAKES_EFFECT.replace("get it", "run this way")}` });
              refetch(["mcp_servers_get"]);
            },
            (e: unknown) => {
              setBusy(false);
              setEcho({ ok: false, text: errorText(e) });
            },
          );
        }}
      />
      <EchoLine echo={echo} />
    </Setting>
  );
}

/** A project's MCP section: its own servers, and the global ones it gets unless it replaces them. */
export function McpSection({ projectRef }: { projectRef: Ref }) {
  const live = useLive();
  const read = useToolQuery("mcp_servers_get", { project: projectRef }, { enabled: live });
  if (read.isLoadingError) {
    return (
      <Setting reveal="projects.mcp" label="MCP servers" help="Tools this project's agents get.">
        <Text tone="danger">{errorText(read.error)}</Text>
      </Setting>
    );
  }
  const data = read.data;
  if (!data) return null;
  // A Navi's integrations are kept on its Integrations section, where saving keeps what each is to the tool policy.
  const all = data.project ?? [];
  const own = all.filter((x) => x.integration === undefined);
  const integrations = all.length - own.length;
  const globals = globalsFor(data.global, all);
  return (
    <ServersSetting
      reveal="projects.mcp"
      label="MCP servers"
      help="This project's own, for the roles you pick; one replaces a global server of the same name here."
      scope={projectRef}
      servers={own}
      taken={all.map((x) => x.name)}
    >
      {integrations > 0 ? (
        <Text size="xs" tone="quiet">
          {integrations === 1 ? "1 more is" : `${String(integrations)} more are`} under Integrations above.
        </Text>
      ) : null}
      {globals.length > 0 ? (
        <div className={s.stack}>
          <Text size="xs" tone="quiet">
            From Settings › MCP servers:
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
    </ServersSetting>
  );
}

type Editing = { kind: "new" } | { kind: "edit"; server: McpServer } | { kind: "remove"; server: McpServer };

function ServersSetting(props: { reveal: string; label: string; help: string; scope: Ref | null; servers: ReadonlyArray<McpServer>; taken?: ReadonlyArray<string>; children?: React.ReactNode }) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [echo, setEcho] = useState<{ ok: boolean; text: string } | null>(null);
  const machines = useMachineIds();
  const shownOn = props.scope === null ? machines : [props.scope.machineId];
  const done = (text: string) => {
    setEditing(null);
    setEcho({ ok: true, text });
  };
  return (
    <Setting reveal={props.reveal} label={props.label} help={props.help}>
      {props.servers.length === 0 ? (
        <Text size="sm" tone="quiet">
          None yet.
        </Text>
      ) : (
        <div role="list" aria-label={props.label} className={s.stack}>
          {props.servers.map((server) => (
            <ServerRow key={server.name} server={server} missing={missingOn(server, shownOn)} onEdit={() => setEditing({ kind: "edit", server })} onRemove={() => setEditing({ kind: "remove", server })} />
          ))}
        </div>
      )}
      {props.children}
      <div className={s.inline}>
        <Button onClick={() => setEditing({ kind: "new" })}>Add server</Button>
      </div>
      <EchoLine echo={echo} />
      {editing?.kind === "new" || editing?.kind === "edit" ? (
        <ServerEditor
          scope={props.scope}
          editing={editing.kind === "edit" ? editing.server : null}
          taken={props.taken ?? props.servers.map((x) => x.name)}
          onClose={() => setEditing(null)}
          onSaved={(name, missing) =>
            done(`Saved ${name}. ${TAKES_EFFECT}${missing.length > 0 ? ` Its secrets aren't on ${missing.join(", ")} yet: save it again while they're online.` : ""}`)
          }
        />
      ) : null}
      {editing?.kind === "remove" ? <ConfirmRemove server={editing.server} onClose={() => setEditing(null)} onRemoved={() => done(`Removed ${editing.server.name}. Agents already running keep it until they next start.`)} /> : null}
    </Setting>
  );
}

function ServerRow(props: { server: McpServer; missing: string[]; onEdit: () => void; onRemove: () => void }) {
  const { server } = props;
  const hubCall = useHubCall();
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<{ machineId: string; result: McpTestResult } | { error: string } | null>(null);
  const values = valuesText(server);
  const test = () => {
    setTesting(true);
    setTested(null);
    hubCall("mcp_server_test", { scope: server.scope, name: server.name }).then(
      (out) => {
        setTesting(false);
        setTested({ machineId: out.machineId, result: out.result });
      },
      (e: unknown) => {
        setTesting(false);
        setTested({ error: errorText(e) });
      },
    );
  };
  return (
    <div role="listitem" aria-label={server.name} className={s.stack}>
      <div className={s.inline}>
        <Text mono strong size="sm">
          {server.name}
        </Text>
        <Text size="xs" tone="quiet">
          {server.enabled ? rolesText(server.roles) : "Off"}
        </Text>
        <Button size="sm" variant="ghost" disabled={testing} onClick={test}>
          {testing ? "Testing…" : "Test connection"}
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onEdit}>
          Edit
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onRemove}>
          Remove
        </Button>
      </div>
      <Truncate size="sm" tone="quiet" mono>
        {transportText(server)}
      </Truncate>
      {values !== "" ? (
        <Truncate size="xs" tone="quiet" mono>
          {values}
        </Truncate>
      ) : null}
      {props.missing.length > 0 ? (
        <Text size="xs" tone="danger">
          Its secrets aren't on {props.missing.join(", ")}: agents there go without it. Edit and save it while they're online.
        </Text>
      ) : null}
      {tested ? <TestResult tested={tested} /> : null}
    </div>
  );
}

function TestResult({ tested }: { tested: { machineId: string; result: McpTestResult } | { error: string } }) {
  if ("error" in tested) {
    return (
      <div role="alert">
        <Text size="sm" tone="danger">
          {tested.error}
        </Text>
      </div>
    );
  }
  const { result, machineId } = tested;
  if (result.error !== undefined) {
    return (
      <div role="alert">
        <Text size="sm" tone="danger">
          Failed on {machineId}: {result.error}
        </Text>
      </div>
    );
  }
  const tools = result.tools ?? [];
  return (
    <div role="status" className={s.stack}>
      <Text size="sm" tone="quiet">
        Connected on {machineId}
        {result.server ? ` to ${result.server}` : ""}: {tools.length} {tools.length === 1 ? "tool" : "tools"}.
      </Text>
      {tools.length > 0 ? (
        <Truncate size="xs" tone="quiet" mono>
          {tools.map((t) => t.name).join(", ")}
        </Truncate>
      ) : null}
    </div>
  );
}

const KINDS: ReadonlyArray<{ kind: TransportKind; label: string }> = [
  { kind: "stdio", label: "Command" },
  { kind: "http", label: "HTTP" },
  { kind: "sse", label: "SSE" },
];

const ROLES: ReadonlyArray<{ key: keyof McpRoles; label: string; description: string }> = [
  { key: "lead", label: "Lead", description: "The project's lead." },
  { key: "writers", label: "Writers", description: "Agents of write tasks." },
  { key: "reviewers", label: "Reviewers", description: "Agents of review and read tasks." },
];

function ServerEditor(props: { scope: Ref | null; editing: McpServer | null; taken: ReadonlyArray<string>; onClose: () => void; onSaved: (name: string, missing: string[]) => void }) {
  const { hub } = useDataLayer();
  const [draft, setDraft] = useState<Draft>(() => (props.editing ? draftOf(props.editing) : emptyDraft()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxes = useBoxes(props.scope);
  const refetch = useRefetch();
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const setValue = (i: number, patch: Partial<DraftValue>) => set({ values: draft.values.map((v, j) => (j === i ? { ...v, ...patch } : v)) });
  const nameIssue = props.editing ? null : nameProblem(draft.name.trim(), props.taken);
  const built = toRequest(draft, scopeOf(props.scope), boxes);
  const stdio = draft.kind === "stdio";
  const save = () => {
    if (!built.ok) return;
    setBusy(true);
    setError(null);
    window.fleetd.secret.mcpServer(hub, built.request).then(
      (out) => {
        setBusy(false);
        if (!out.ok) {
          setError(errorText(new CallError(out.error)));
          return;
        }
        refetch(["mcp_servers_get"]);
        const missing = (out.output as { missingOn?: unknown } | null)?.missingOn;
        props.onSaved(built.request.name, Array.isArray(missing) ? missing.filter((m): m is string => typeof m === "string") : []);
      },
      (e: unknown) => {
        setBusy(false);
        setError(errorText(e));
      },
    );
  };
  return (
    <Dialog
      open
      wide
      onOpenChange={(open) => !open && !busy && props.onClose()}
      title={props.editing ? `Edit ${props.editing.name}` : "Add an MCP server"}
      description={`${props.scope === null ? "For every project." : "For this project only."} ${TAKES_EFFECT}`}
      footer={
        <>
          <Button onClick={props.onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !built.ok || nameIssue !== null} onClick={save}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className={s.stack}>
        <Field label="Name" error={nameIssue} description="How agents see its tools: mcp__<name>__<tool>.">
          <Input mono value={draft.name} disabled={props.editing !== null || busy} autoComplete="off" spellCheck={false} placeholder="github" onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <RadioGroup className={s.radios} value={draft.kind} onValueChange={(v) => set({ kind: v === "http" || v === "sse" ? v : "stdio" })} aria-label="How agents reach it">
          {KINDS.map((k) => (
            <Radio key={k.kind} value={k.kind} label={k.label} />
          ))}
        </RadioGroup>
        {stdio ? (
          <>
            <Field label="Command" description="Started by each agent's claude on its machine, in its working directory.">
              <Input mono aria-label="Command" value={draft.command} disabled={busy} spellCheck={false} placeholder="npx" onChange={(e) => set({ command: e.target.value })} />
            </Field>
            <Field label="Arguments" description="One per line.">
              <Textarea mono aria-label="Arguments" value={draft.args} minRows={1} maxRows={8} disabled={busy} spellCheck={false} placeholder={"-y\n@modelcontextprotocol/server-github"} onChange={(e) => set({ args: e.target.value })} />
            </Field>
          </>
        ) : (
          <Field label="URL">
            <Input mono aria-label="URL" value={draft.url} disabled={busy} spellCheck={false} placeholder="https://mcp.example.com/mcp" onChange={(e) => set({ url: e.target.value })} />
          </Field>
        )}
        <Text strong size="sm">
          {stdio ? "Environment" : "Headers"}
        </Text>
        <Text size="xs" tone="quiet">
          A secret is sealed on this computer to {props.scope === null ? "every machine" : "the project's machine"}; fleetd never shows it again.
        </Text>
        {draft.values.map((v, i) => (
          <div key={i} role="group" aria-label={v.name || `Value ${i + 1}`} className={s.inline}>
            <Input mono aria-label="Name" value={v.name} disabled={busy} spellCheck={false} placeholder={stdio ? "GITHUB_TOKEN" : "Authorization"} onChange={(e) => setValue(i, { name: e.target.value })} />
            <Input
              mono
              aria-label="Value"
              className={v.secret ? s.secretValue : undefined}
              data-secret={v.secret ? "" : undefined}
              value={v.value}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              placeholder={v.secret && v.saved ? "Saved: type to replace" : ""}
              onChange={(e) => setValue(i, { value: e.target.value })}
            />
            <Switch label="Secret" checked={v.secret} disabled={busy} onCheckedChange={(on) => setValue(i, { secret: on, value: on === v.secret ? v.value : "" })} />
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => set({ values: draft.values.filter((_, j) => j !== i) })}>
              Remove
            </Button>
          </div>
        ))}
        <div className={s.inline}>
          <Button size="sm" disabled={busy || draft.values.length >= 50} onClick={() => set({ values: [...draft.values, { name: "", secret: false, value: "", saved: false }] })}>
            {stdio ? "Add variable" : "Add header"}
          </Button>
        </div>
        <Text strong size="sm">
          Who gets it
        </Text>
        {ROLES.map((r) => (
          <Checkbox key={r.key} label={r.label} description={r.description} checked={draft.roles[r.key]} disabled={busy} onCheckedChange={(on) => set({ roles: { ...draft.roles, [r.key]: on === true } })} />
        ))}
        <Switch label="On" checked={draft.enabled} disabled={busy} onCheckedChange={(on) => set({ enabled: on })} />
        {!built.ok && draft.name.trim() !== "" ? (
          <Text size="sm" tone="quiet">
            {built.problem}
          </Text>
        ) : null}
        <Problem text={error} />
      </div>
    </Dialog>
  );
}

function ConfirmRemove(props: { server: McpServer; onClose: () => void; onRemoved: () => void }) {
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = () => {
    setBusy(true);
    setError(null);
    hubCall("mcp_server_remove", { scope: props.server.scope, name: props.server.name }).then(
      () => {
        setBusy(false);
        refetch(["mcp_servers_get"]);
        props.onRemoved();
      },
      (e: unknown) => {
        setBusy(false);
        setError(errorText(e));
      },
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !busy && props.onClose()}
      title={`Remove ${props.server.name}?`}
      description="New agents start without it, and its secrets are gone from the machines."
      footer={
        <>
          <Button onClick={props.onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy} onClick={remove}>
            {busy ? "Removing…" : "Remove"}
          </Button>
        </>
      }
    >
      <Problem text={error} />
    </Dialog>
  );
}

function EchoLine({ echo }: { echo: { ok: boolean; text: string } | null }) {
  if (!echo) return null;
  return (
    <div role={echo.ok ? "status" : "alert"}>
      <Text size="sm" tone={echo.ok ? "quiet" : "danger"}>
        {echo.text}
      </Text>
    </div>
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
