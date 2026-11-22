// Signing in to an MCP server that offers OAuth (a named service's Connect, a custom MCP's Sign in): mcp_oauth_start
// answers with the service's own page, which opens in the browser; the dialog follows the server's sign-in as the
// hub has it until it is done, then the server is tested. A service that lets no app register itself asks for the
// person's own OAuth app (its client secret sealed in main to the hub's key). A named service goes straight to its
// page: there is nothing to read or type first.
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import type { McpOauthStartOutput, McpScope, McpServer } from "../../../shared/contracts";
import { CallError } from "../../src/data/queries";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { Button, Dialog, Field, InlineCode, Input, Text } from "../../ui";
import { CommandLine } from "../onboarding/Prose";
import { errorText, useHubCall, useLive, useRefetch } from "../settings/hub";
import type { Named } from "../settings/namedServers";
import { hostOf, markOf, signInOutcome, type SignInMark } from "./signInModel";
import c from "./connections.module.css";

const open = (url: string): void => void window.fleetd.openExternal(url);

type Phase =
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
function useSignIn(scope: McpScope, name: string, onSignedIn: () => void) {
  const { hub } = useDataLayer();
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const live = useLive();
  // Where this app reaches the hub: the service sends the browser back there.
  const appUrl = useData((st) => (st.hub.phase === "unpaired" ? undefined : st.hub.hub));
  const read = useToolQuery("mcp_servers_get", scope.kind === "project" ? { project: { machineId: scope.machineId, projectId: scope.projectId } } : {}, { enabled: live });
  // A bot's server that signs in is the team's from its sign-in on (D592): followed there.
  const oauth = [...(read.data?.project ?? []), ...(read.data?.global ?? [])].find((x) => x.name === name && x.oauth !== undefined)?.oauth;
  const [phase, setPhase] = useState<Phase>({ kind: "ready" });
  const [problem, setProblem] = useState<string | null>(null);
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
  const failed = (e: unknown, back: Phase) => {
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

/** What the sign-in shows: why it signs in again, the person's own app's fields, or that the browser is open. */
function Body({ signIn, url, why, client, setClient }: { signIn: SignIn; url: string; why?: string | undefined; client: { id: string; secret: string }; setClient: (c: { id: string; secret: string }) => void }) {
  const { phase } = signIn;
  if (phase.kind === "connected") {
    return (
      <div role="status">
        <Text size="sm">Signed in. Testing it…</Text>
      </div>
    );
  }
  if (phase.kind === "waiting") {
    return (
      <div className={c.stack} data-signin="waiting">
        <div role="status">
          <Text size="sm">Finish signing in on <InlineCode>{hostOf(signIn.oauth?.issuer ?? url)}</InlineCode> in your browser. This moves on by itself.</Text>
        </div>
        <div>
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
      <div className={c.stack}>
        <Text size="sm"><InlineCode>{host}</InlineCode> doesn't let apps sign up by themselves. Make an OAuth app there that allows this redirect URL, then enter its client ID and secret.</Text>
        <section className={c.stack} aria-label="Redirect URL">
          <CommandLine command={phase.redirectUri} />
        </section>
        <Field label="Client ID">
          <Input mono aria-label="Client ID" value={client.id} autoComplete="off" spellCheck={false} onChange={(e) => setClient({ ...client, id: e.target.value })} />
        </Field>
        <Field label="Client secret (optional)">
          <Input mono aria-label="Client secret" data-secret="" value={client.secret} autoComplete="off" spellCheck={false} onChange={(e) => setClient({ ...client, secret: e.target.value })} />
        </Field>
        <Problem text={signIn.problem} />
      </div>
    );
  }
  return (
    <div className={c.stack}>
      {why === undefined ? null : (
        <Text size="sm" tone="danger">
          {words(why)}
        </Text>
      )}
      <Text size="sm">Your browser opens <InlineCode>{hostOf(url)}</InlineCode>'s own sign-in page. You come back here once it's done.</Text>
      <Problem text={signIn.problem} />
    </div>
  );
}

function Footer({ signIn, client, onCancel }: { signIn: SignIn; client: { id: string; secret: string }; onCancel: () => void }) {
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

/** Signs in to `server`, then calls `onSignedIn` (which tests it). A named service opens its page at once. */
export function SignInDialog(props: { server: McpServer; named?: Named | undefined; onClose: () => void; onSignedIn: () => void }) {
  const { server } = props;
  const [client, setClient] = useState({ id: "", secret: "" });
  const signIn = useSignIn(server.scope, server.name, () => {
    props.onSignedIn();
    props.onClose();
  });
  const url = server.transport.type === "stdio" ? "" : server.transport.url;
  const again = server.oauth?.signedInAt !== undefined;
  // Once, as a dev build's effects run twice.
  const began = useRef(false);
  const { begin } = signIn;
  const auto = props.named !== undefined;
  useEffect(() => {
    if (!auto || began.current) return;
    began.current = true;
    begin();
  }, [auto, begin]);
  const label = props.named?.label ?? server.name;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && signIn.phase.kind !== "starting" && props.onClose()}
      title={again && props.named === undefined ? `Sign in to ${label} again` : `Sign in to ${label}`}
      footer={<Footer signIn={signIn} client={client} onCancel={props.onClose} />}
    >
      <Body signIn={signIn} url={url} why={server.oauth?.problem} client={client} setClient={setClient} />
    </Dialog>
  );
}

/** The hub's words, its `code` spans (a host, a command) as code. */
export const words = (text: string): ReactNode[] => {
  const parts = text.split("`");
  return parts.map((part, i) => (i % 2 === 1 && i < parts.length - 1 ? <InlineCode key={i}>{part}</InlineCode> : part));
};

export function Problem({ text }: { text: string | null }) {
  if (text === null) return null;
  return (
    <span role="alert">
      <Text size="sm" tone="danger">
        {words(text)}
      </Text>
    </span>
  );
}
