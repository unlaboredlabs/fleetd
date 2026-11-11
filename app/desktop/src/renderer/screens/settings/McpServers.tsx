// MCP servers: HubMcpServers, the ones every project's agents get and whether they also get their own (Settings ›
// Hub › Every project › Agents, owners and admins only, D209); and the editor and remove dialogs a project's
// own servers use on its Project page (Integrations.tsx), where its one MCP servers list is. Reads
// mcp_servers_get; saves through main (mcp_server_set, each secret sealed there to each machine's key), removes with
// mcp_server_remove and tests with mcp_server_test. A secret's value is write-only: typed here once, sealed in main, never shown again.
import { useState } from "react";
import { Button, Dialog, Field, Input, Radio, RadioGroup, Switch, Text, Textarea, Truncate } from "../../ui";
import type { McpScope, McpServer, McpTestResult } from "../../../shared/contracts";
import type { McpServerRequest } from "../../../shared/ipc";
import { CallError } from "../../src/data/queries";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import { draftOf, emptyDraft, missingOn, nameProblem, rolesText, toRequest, transportText, valuesText, type Draft, type DraftValue, type TransportKind } from "./mcpModel";
import { AddButton, GroupNote, SettingsList, SettingsListRow, SettingsRow, SwitchRow } from "./parts";
import s from "./settings.module.css";
import { boxOf } from "./claudeModel";

/** When a change reaches agents, said wherever one is saved. */
export const TAKES_EFFECT = "Agents started from now on get it; one already running at its next start, after its next message.";

type Ref = { machineId: string; projectId: string };

const scopeOf = (ref: Ref | null): McpScope => (ref === null ? { kind: "global" } : { kind: "project", ...ref });

/** The box keys a scope's secrets are sealed to: a project's machine, or every machine for a global server. */
function useBoxes(ref: Ref | null): McpServerRequest["boxes"] {
  const machines = useData((d) => d.machines);
  return Object.values(machines)
    .filter((m) => ref === null || m.machineId === ref.machineId)
    .flatMap((m) => {
      const box = boxOf(m);
      return box === undefined ? [] : [{ machineId: m.machineId, boxPubKey: box }];
    });
}

function useMachineIds(): string[] {
  const machines = useData((d) => d.machines);
  return Object.keys(machines).sort();
}

/** Settings › Hub › Every project: the MCP servers every project's agents get, and whether they also get their own. */
export function HubMcpServers() {
  const live = useLive();
  const read = useToolQuery("mcp_servers_get", {}, { enabled: live });
  if (!live) return <GroupNote>Connect to a hub to see and change this.</GroupNote>;
  const data = read.data;
  return (
    <>
      {read.isLoadingError ? (
        <SettingsRow
          title="Couldn't read the MCP servers"
          line={errorText(read.error)}
          lineTone="danger"
          control={
            <Button size="sm" onClick={() => void read.refetch()}>
              Try again
            </Button>
          }
        />
      ) : null}
      {data ? (
        <>
          <ServersSetting
            label="Global MCP servers"
            help="Given to every project's lead, and its agents too when you say so, as commands on their machine or services over HTTP. A project's own replaces one of the same name."
            scope={null}
            servers={data.global}
          />
          <UserServers on={data.userServers} />
        </>
      ) : read.isLoadingError ? null : (
        <GroupNote>Loading…</GroupNote>
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
    <>
      <SwitchRow
        reveal="mcp.user"
        title="Agents also get their own MCP servers"
        hint="The servers in the claude setup where an agent runs (~/.claude.json, a repo's .mcp.json). Off: agents get fleetd's tools and the servers here only. fleetd's own tools are always there."
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
    </>
  );
}

type Editing = { kind: "new" } | { kind: "edit"; server: McpServer } | { kind: "remove"; server: McpServer };

function ServersSetting(props: { label: string; help: string; scope: Ref | null; servers: ReadonlyArray<McpServer> }) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [echo, setEcho] = useState<{ ok: boolean; text: string } | null>(null);
  const machines = useMachineIds();
  const shownOn = props.scope === null ? machines : [props.scope.machineId];
  const done = (text: string) => {
    setEditing(null);
    setEcho({ ok: true, text });
  };
  return (
    <>
      <SettingsRow title={props.label} hint={props.help} control={<AddButton label="Add server" onClick={() => setEditing({ kind: "new" })} />} />
      {props.servers.length === 0 ? (
        <GroupNote>None yet.</GroupNote>
      ) : (
        <SettingsList label={props.label}>
          {props.servers.map((server) => (
            <ServerRow key={server.name} server={server} missing={missingOn(server, shownOn)} onEdit={() => setEditing({ kind: "edit", server })} onRemove={() => setEditing({ kind: "remove", server })} />
          ))}
        </SettingsList>
      )}
      <EchoLine echo={echo} />
      {editing?.kind === "new" || editing?.kind === "edit" ? (
        <ServerEditor
          scope={props.scope}
          editing={editing.kind === "edit" ? editing.server : null}
          taken={props.servers.map((x) => x.name)}
          onClose={() => setEditing(null)}
          onSaved={(name, missing) =>
            done(`Saved ${name}. ${TAKES_EFFECT}${missing.length > 0 ? ` Its secrets aren't on ${missing.join(", ")} yet: save it again while they're online.` : ""}`)
          }
        />
      ) : null}
      {editing?.kind === "remove" ? <ConfirmRemove server={editing.server} onClose={() => setEditing(null)} onRemoved={() => done(`Removed ${editing.server.name}. Agents already running keep it until they next start.`)} /> : null}
    </>
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
    <SettingsListRow
      name={<Text mono>{server.name}</Text>}
      label={server.name}
      meta={server.enabled ? rolesText(server.roles) : "Off"}
      controls={
        <>
          <Button size="sm" variant="ghost" disabled={testing} onClick={test}>
            {testing ? "Testing…" : "Test connection"}
          </Button>
          <Button size="sm" variant="ghost" onClick={props.onEdit}>
            Edit
          </Button>
          <Button size="sm" variant="ghost" onClick={props.onRemove}>
            Remove
          </Button>
        </>
      }
    >
      <Truncate size="sm" tone="quiet" mono>
        {transportText(server)}
      </Truncate>
      {values !== "" ? (
        <Truncate size="sm" tone="quiet" mono>
          {values}
        </Truncate>
      ) : null}
      {props.missing.length > 0 ? (
        <Text size="sm" tone="danger">
          Its secrets aren't on {props.missing.join(", ")}: agents there go without it. Edit and save it while they're online.
        </Text>
      ) : null}
      {tested ? <TestResult tested={tested} /> : null}
    </SettingsListRow>
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

export function ServerEditor(props: { scope: Ref | null; editing: McpServer | null; taken: ReadonlyArray<string>; onClose: () => void; onSaved: (name: string, missing: string[]) => void }) {
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
        <Switch
          label="Agents get it too"
          description={
            draft.agents
              ? "Its writers and reviewers get it as well, and none of its tools asks you: agents can't stop to ask."
              : `Only ${props.scope === null ? "each project's lead" : "its lead"} gets it.`
          }
          checked={draft.agents}
          disabled={busy}
          onCheckedChange={(agents) => set({ agents })}
        />
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

export function ConfirmRemove(props: { server: McpServer; onClose: () => void; onRemoved: () => void }) {
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

/** What a change did, or why not, as a note in its group. */
function EchoLine({ echo }: { echo: { ok: boolean; text: string } | null }) {
  if (!echo) return null;
  return (
    <GroupNote tone={echo.ok ? "quiet" : "danger"}>
      <span role={echo.ok ? "status" : "alert"}>{echo.text}</span>
    </GroupNote>
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
