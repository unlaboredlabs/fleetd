// Connections › Custom MCP, in the sheet's place: a URL or a command, its name (made from what was typed until the
// person types one), headers or env variables whose values are vault items (the hub seals them to the machines; the
// app never holds them), and which bots use it. Add saves it for the team (mcp_server_set) and tests it at once
// (mcp_server_test): a plain line says what came back. A server that offers OAuth goes to its sign-in, then is
// tested. A URL on the tailnet is reached through the Tailscale connection: the form says so, or that Tailscale
// isn't connected yet, with Connect right there for an admin. An admin adds a command or headers; anyone adds a URL
// that signs in, as the hub allows.
import { X } from "lucide-react";
import { useState } from "react";
import type { McpServer, McpServerSetOutput, VaultItemSummary } from "../../../shared/contracts";
import { CallError } from "../../src/data/queries";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { Button, Field, Input, Menu, MenuCheckboxItem, MenuContent, MenuSeparator, MenuTrigger, Segmented, Select, Tooltip } from "../../ui";
import { errorText, useHubCall, useLive, useRefetch } from "../settings/hub";
import type { Tailnet } from "../settings/Tailscale";
import { TailscaleMark } from "./marks";
import { draftOf, emptyDraft, isKeyHeader, isTailnetHost, nameOf, needsSignIn, pickedText, suggestedName, testLine, toggleBot, toInput, type Draft, type DraftValue, type Tested } from "./model";
import { Problem, SignInDialog } from "./SignIn";
import { requestOf } from "./signInModel";
import c from "./connections.module.css";

interface Bot {
  readonly machineId: string;
  readonly projectId: string;
  readonly title: string;
}

type Phase = { kind: "edit" } | { kind: "saving" } | { kind: "testing"; server: McpServer } | { kind: "tested"; server: McpServer; tested: Tested } | { kind: "signin"; server: McpServer };

const KINDS = [
  { value: "url", label: "URL" },
  { value: "command", label: "Command" },
] as const;

/** The value picker's first choice: a plain value typed in the form, not a vault item. */
const PLAIN = "plain:";

const PREFIXES = [
  { value: "bearer", label: "Bearer" },
  { value: "none", label: "As is" },
] as const;

/** The vault items a value may come from: the team's logins and variables, and a bot's own variables for its own server. */
function useItems(server: McpServer | null): VaultItemSummary[] {
  const live = useLive();
  const team = useToolQuery("vault_list", {}, { enabled: live });
  const scope = server?.scope;
  const own = useToolQuery("vault_list", scope?.kind === "project" ? { machineId: scope.machineId, projectId: scope.projectId } : {}, { enabled: live && scope?.kind === "project" });
  const usable = (i: VaultItemSummary) => i.deletedMs === undefined && (i.kind === "login" || i.kind === "env");
  return [...(team.data?.items ?? []).filter((i) => usable(i) && i.scope === "hub"), ...(scope?.kind === "project" ? (own.data?.items ?? []).filter((i) => usable(i) && i.scope === "project") : [])];
}

export function CustomForm(props: { editing: McpServer | null; taken: ReadonlyArray<string>; bots: ReadonlyArray<Bot>; tailnet: Tailnet; admin: boolean; onDone: () => void }) {
  const { editing, admin } = props;
  const { hub } = useDataLayer();
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const machines = useData((d) => d.machines);
  const items = useItems(editing);
  const [draft, setDraft] = useState<Draft>(() => (editing === null ? emptyDraft() : draftOf(editing)));
  // The server as saved: the one being edited, or a new one once its first save went through, so fixing it after a
  // failed Test saves it again instead of meeting its own name as taken (or making a second one).
  const [saved, setSaved] = useState<McpServer | null>(editing);
  const [phase, setPhase] = useState<Phase>({ kind: "edit" });
  const [problem, setProblem] = useState<string | null>(null);
  const change = (next: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...next }));
    setProblem(null);
    if (phase.kind === "tested") setPhase({ kind: "edit" });
  };
  const command = draft.kind === "command";
  const team = saved === null || saved.scope.kind === "global";
  const onTailnet = !command && isTailnetHost(draft.url);

  const test = (server: McpServer) => {
    setPhase({ kind: "testing", server });
    hubCall("mcp_server_test", { scope: server.scope, name: server.name }).then(
      (out) => setPhase({ kind: "tested", server, tested: { machineId: out.machineId, result: out.result } }),
      (e: unknown) => setPhase({ kind: "tested", server, tested: { error: errorText(e) } }),
    );
  };
  const submit = () => {
    const built = toInput(draft, saved, props.taken);
    if (!built.ok) {
      setProblem(built.problem);
      return;
    }
    setPhase({ kind: "saving" });
    setProblem(null);
    window.fleetd.secret.mcpServer(hub, requestOf(built.input)).then(
      (out) => {
        if (!out.ok) {
          setPhase({ kind: "edit" });
          setProblem(errorText(new CallError(out.error)));
          return;
        }
        refetch(["mcp_servers_get", "setup_list"]);
        const server = (out.output as McpServerSetOutput).server;
        setSaved(server);
        // It offers OAuth: its sign-in first, then the test.
        if (needsSignIn(server)) setPhase({ kind: "signin", server });
        else test(server);
      },
      (e: unknown) => {
        setPhase({ kind: "edit" });
        setProblem(errorText(e));
      },
    );
  };

  const tested = phase.kind === "tested" ? phase.tested : null;
  const signInWanted = phase.kind === "tested" && needsSignIn(phase.server, phase.tested);
  const works = tested !== null && !("error" in tested) && tested.result.error === undefined && tested.result.signIn !== true;
  const result = tested === null || signInWanted ? null : testLine(tested, "machineId" in tested ? (machines[tested.machineId]?.name ?? tested.machineId) : "");
  const busy = phase.kind === "saving" || phase.kind === "testing" || phase.kind === "signin";
  const putValue = (ix: number, value: DraftValue) => change({ values: draft.values.map((v, i) => (i === ix ? value : v)) });
  const setValue = (ix: number, next: Partial<DraftValue>) => change({ values: draft.values.map((v, i) => (i === ix ? { ...v, ...next } : v)) });
  /** A value's source: a plain value typed here, or a vault item. */
  const setSource = (ix: number, v: DraftValue, source: string) => {
    const { plain: _was, ...rest } = v;
    putValue(ix, source === PLAIN ? { ...rest, itemId: "", plain: "" } : { ...rest, itemId: source });
  };
  const addValue = () => change({ values: [...draft.values, { name: command ? "" : draft.values.length === 0 ? "Authorization" : "", itemId: "", prefix: command || draft.values.length > 0 ? "" : "Bearer " }] });
  const vaultOptions = items.map((i) => ({ value: i.itemId, label: i.kind === "env" ? (i.envName ?? i.label) : i.label }));
  // A key (Authorization) comes from the vault, with its prefix; any other value may be plain text too.
  const optionsFor = (v: DraftValue) => (!command && isKeyHeader(v.name) && v.plain === undefined ? vaultOptions : [{ value: PLAIN, label: "Plain value" }, ...vaultOptions]);

  return (
    <>
      <div className={c.body}>
        <div className={c.form} data-form={command ? "command" : "url"}>
          {admin ? <Segmented label="Kind" options={KINDS} value={draft.kind} onChange={(kind) => change({ kind, values: [] })} /> : null}
          {command ? (
            <Field label="Command">
              <Input mono aria-label="Command" placeholder="npx -y @acme/mcp-server" value={draft.command} autoFocus={editing === null} onChange={(e) => change({ command: e.target.value })} />
            </Field>
          ) : (
            <Field label="URL">
              <Input mono aria-label="URL" placeholder="https://mcp.example.com/mcp" value={draft.url} autoFocus={editing === null} onChange={(e) => change({ url: e.target.value })} />
            </Field>
          )}
          {onTailnet ? <TailnetLine tailnet={props.tailnet} admin={admin} /> : null}
          <Field label="Name">
            <Input
              mono
              aria-label="Name"
              placeholder={suggestedName(draft) || "my-server"}
              value={draft.named ? draft.name : suggestedName(draft)}
              disabled={saved !== null}
              onChange={(e) => change({ name: e.target.value, named: true })}
            />
          </Field>
          {admin ? (
            <section className={c.values} aria-label={command ? "Environment" : "Headers"}>
              <div className={c.valuesHead}>
                <span className={c.fieldLabel}>{command ? "Environment" : "Headers"}</span>
                <Button size="sm" variant="ghost" onClick={addValue}>
                  {command ? "Add variable" : "Add header"}
                </Button>
              </div>
              {draft.values.map((v, ix) => (
                <div key={ix} className={c.value}>
                  <Input mono aria-label={command ? "Variable" : "Header"} placeholder={command ? "API_TOKEN" : "Authorization"} value={v.name} onChange={(e) => setValue(ix, { name: e.target.value })} />
                  {!command && isKeyHeader(v.name) && v.plain === undefined ? (
                    <Select aria-label="Prefix" className={c.prefix} options={PREFIXES} value={v.prefix === "" ? "none" : "bearer"} onValueChange={(p) => setValue(ix, { prefix: p === "bearer" ? "Bearer " : "" })} />
                  ) : null}
                  <Select
                    aria-label={`${v.name || "Value"}'s value`}
                    className={c.item}
                    options={optionsFor(v)}
                    value={v.plain !== undefined ? PLAIN : v.itemId === "" ? undefined : v.itemId}
                    placeholder={v.keep === true ? "Saved key" : optionsFor(v).length === 0 ? "No vault items yet" : "From the vault"}
                    disabled={optionsFor(v).length === 0}
                    onValueChange={(source) => setSource(ix, v, source)}
                  />
                  {v.plain === undefined ? null : (
                    <Input mono aria-label={`${v.name || "Value"} value`} className={c.item} placeholder="value" value={v.plain} onChange={(e) => setValue(ix, { plain: e.target.value })} />
                  )}
                  <Button size="sm" variant="ghost" iconOnly aria-label={`Remove ${v.name || "this one"}`} onClick={() => change({ values: draft.values.filter((_, i) => i !== ix) })}>
                    <X aria-hidden />
                  </Button>
                </div>
              ))}
            </section>
          ) : (
            // Off for a member, with why in its hover: a command or a key reaches every teammate's agents.
            <div className={c.valuesHead}>
              <span className={c.fieldLabel}>Headers</span>
              <Tooltip content="An owner or admin adds a command or headers. A URL that signs in, anyone adds.">
                <span tabIndex={0}>
                  <Button size="sm" variant="ghost" disabled>
                    Add header
                  </Button>
                </span>
              </Tooltip>
            </div>
          )}
          {team && props.bots.length > 0 ? (
            <div className={c.botsField}>
              <span className={c.fieldLabel}>Bots</span>
              <Menu>
                <MenuTrigger asChild>
                  <Button size="sm" aria-label={`Bots: ${pickedText(draft.bots, props.bots)}`}>
                    {pickedText(draft.bots, props.bots)}
                  </Button>
                </MenuTrigger>
                <MenuContent align="start" className={c.menu}>
                  <MenuCheckboxItem checked={draft.bots === undefined} onSelect={(e) => e.preventDefault()} onCheckedChange={() => change({ bots: draft.bots === undefined ? [] : undefined })}>
                    Every bot
                  </MenuCheckboxItem>
                  <MenuSeparator />
                  {props.bots.map((b) => (
                    <MenuCheckboxItem
                      key={`${b.machineId}/${b.projectId}`}
                      checked={draft.bots === undefined || draft.bots.some((p) => p.machineId === b.machineId && p.projectId === b.projectId)}
                      onSelect={(e) => e.preventDefault()}
                      onCheckedChange={() => change({ bots: toggleBot(draft.bots, b, props.bots) })}
                    >
                      {b.title}
                    </MenuCheckboxItem>
                  ))}
                </MenuContent>
              </Menu>
            </div>
          ) : null}
          {phase.kind === "testing" ? (
            <span className={c.line} data-tone="quiet" role="status">
              Testing {phase.server.name}…
            </span>
          ) : null}
          {result === null ? null : (
            <span className={c.line} data-tone={result.tone} role={result.tone === "danger" ? "alert" : "status"} data-result={works ? "works" : "failed"}>
              {result.text}
            </span>
          )}
          {signInWanted ? (
            <span className={c.signInLine} role="status">
              <span className={c.line} data-tone="warning">
                {phase.server.name} signs in with OAuth.
              </span>
              <Button size="sm" variant="primary" onClick={() => setPhase({ kind: "signin", server: phase.server })}>
                Sign in with OAuth
              </Button>
            </span>
          ) : null}
          <Problem text={problem} />
        </div>
      </div>
      <footer className={c.formFoot}>
        {works ? null : (
          <Button onClick={props.onDone} disabled={phase.kind === "saving"}>
            Cancel
          </Button>
        )}
        {works ? (
          <Button variant="primary" onClick={props.onDone}>
            Done
          </Button>
        ) : (
          <Button variant="primary" disabled={busy || nameOf(draft) === "" || (command ? draft.command.trim() === "" : draft.url.trim() === "")} onClick={submit}>
            {phase.kind === "saving" ? "Saving…" : phase.kind === "testing" ? "Testing…" : tested !== null ? "Save and test again" : saved === null ? "Add and test" : "Save and test"}
          </Button>
        )}
      </footer>
      {phase.kind === "signin" ? (
        <SignInDialog
          server={phase.server}
          onClose={() => setPhase((p) => (p.kind === "signin" ? { kind: "tested", server: p.server, tested: { machineId: "", result: { signIn: true } } } : p))}
          onSignedIn={() => test(phase.server)}
        />
      ) : null}
    </>
  );
}

/** Under a URL on the tailnet: that Tailscale reaches it, or that it isn't connected yet, with Connect for an admin. */
function TailnetLine({ tailnet, admin }: { tailnet: Tailnet; admin: boolean }) {
  const state = tailnet.state;
  const connected = state?.status === "connected";
  return (
    <span className={c.tailnetLine} data-tailnet-line={state?.status ?? "none"}>
      <span className={c.via} aria-hidden>
        <TailscaleMark />
      </span>
      <span className={c.line} data-tone={connected ? "quiet" : "warning"}>
        {connected ? `On your tailnet: reached through Tailscale (${state.tailnet ?? "connected"}).` : "On your tailnet: connect Tailscale to reach it."}
      </span>
      {!connected && admin && state !== undefined && (state.status === "off" || state.status === "failed") && state.problem === undefined ? (
        <Button size="sm" disabled={tailnet.busy} onClick={tailnet.connect}>
          {tailnet.busy ? "Connecting…" : "Connect Tailscale"}
        </Button>
      ) : null}
    </span>
  );
}
