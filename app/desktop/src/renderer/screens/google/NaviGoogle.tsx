// A Navi's Google, the first row of its Integrations: Connect, Reconnect and Disconnect, the account and what it
// granted. Connect hands over to main (window.fleetd.google.connect), which opens Google's consent page in the
// browser and calls google_connect with the code it catches, so the page never holds a code or a token. Disconnect is
// google_disconnect, which revokes at Google unless another Navi uses the account. Without the hub's OAuth client, an
// admin is sent to Administration › Google and anyone else told to ask one. Once connected, the person picks when new
// mail wakes the Navi (MailWakeControl, google_mail_set).
import { useState, type ReactNode } from "react";
import type { GoogleConnectOutput, GoogleDisconnectOutput, GoogleGetOutput, MailWake, MailWakeRule } from "../../../shared/contracts";
import { lacksTool } from "../../src/data/errors";
import { CallError } from "../../src/data/queries";
import { useDataLayer, useToolQuery } from "../../src/data/react";
import { Button, Dialog, Field, Input, Segmented, Text, Truncate } from "../../ui";
import { useAdministers } from "../admin/role";
import { toHash } from "../shell/routes";
import { errorText, useHubCall, useLive, useRefetch } from "../settings/hub";
import { dayWords, googleView, lapsedLine, listWords, mailModeLine, queryProblem, scopeFor, scopeName, type GoogleView } from "./model";
import s from "./google.module.css";
import settings from "../settings/settings.module.css";

type Ref = { machineId: string; projectId: string };

const toAdmin = () => {
  window.location.hash = toHash({ id: "admin", section: "google" });
};

/** The scopes granted, as Data access names them, past the account's own (openid, email). */
const grantedNames = (granted: ReadonlyArray<string>): string[] =>
  granted.map(scopeName).filter((n) => n !== "openid" && n !== "email" && n !== "userinfo.email");

export function GoogleRow({ projectRef, machine }: { projectRef: Ref; machine: string }) {
  const live = useLive();
  const admin = useAdministers();
  const read = useToolQuery("google_get", { project: projectRef }, { enabled: live });
  const [dialog, setDialog] = useState<"connect" | "disconnect" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // A hub from before native Google offers none: nothing to show.
  if (read.error instanceof CallError && lacksTool(read.error.error)) return null;
  const view = read.data === undefined ? undefined : googleView(read.data, projectRef.machineId);
  const connected = view?.kind === "connected" || view?.kind === "lapsed" ? view.account : undefined;
  const what = connected?.email ?? "Gmail, Calendar and Drive, with your own Google account.";
  return (
    <div role="listitem" aria-label="Google" className={settings.integration} data-connected={connected === undefined ? undefined : ""}>
      <div className={settings.integrationHead}>
        <div className={settings.stack}>
          <Text strong size="sm">
            Google
          </Text>
          <Truncate size="xs" tone={connected === undefined ? "quiet" : "default"}>
            {what}
          </Truncate>
        </div>
        <div className={settings.inline}>{actions(view, read.error !== null, admin, setDialog)}</div>
      </div>
      {read.error !== null ? (
        <div role="alert">
          <Text size="sm" tone="danger">
            {errorText(read.error)}
          </Text>
        </div>
      ) : view === undefined ? null : (
        <>
          <Under view={view} admin={admin} machine={machine} />
          {view.kind === "connected" && read.data !== undefined ? <MailWakeControl projectRef={projectRef} info={read.data} wake={view.account.mail} /> : null}
        </>
      )}
      {note === null ? null : (
        <div role="status">
          <Text size="xs" tone="quiet">
            {note}
          </Text>
        </div>
      )}
      {dialog === "connect" && read.data !== undefined ? (
        <ConnectGoogle
          projectRef={projectRef}
          info={read.data}
          again={connected !== undefined}
          onClose={() => setDialog(null)}
          onDone={(next) => {
            setDialog(null);
            setNote(next);
          }}
        />
      ) : null}
      {dialog === "disconnect" && connected !== undefined ? (
        <Disconnect
          projectRef={projectRef}
          email={connected.email}
          machine={machine}
          onClose={() => setDialog(null)}
          onDone={(next) => {
            setDialog(null);
            setNote(next);
          }}
        />
      ) : null}
    </div>
  );
}

function actions(view: GoogleView | undefined, failed: boolean, admin: boolean, open: (d: "connect" | "disconnect") => void): ReactNode {
  if (view === undefined) {
    return failed ? null : (
      <Text size="xs" tone="quiet">
        Checking…
      </Text>
    );
  }
  switch (view.kind) {
    case "no-client":
      return admin ? (
        <Button size="sm" onClick={toAdmin}>
          Set up Google
        </Button>
      ) : (
        <Text size="xs" tone="quiet">
          Ask an admin to set up Google
        </Text>
      );
    case "not-held":
      return admin ? (
        <Button size="sm" onClick={toAdmin}>
          Open Administration › Google
        </Button>
      ) : null;
    case "none":
      return (
        <Button size="sm" onClick={() => open("connect")}>
          Connect
        </Button>
      );
    case "connected":
      return (
        <>
          <Text size="xs" tone="quiet">
            Connected
          </Text>
          <Button size="sm" variant="ghost" onClick={() => open("connect")}>
            Reconnect
          </Button>
          <Button size="sm" variant="ghost" onClick={() => open("disconnect")}>
            Disconnect
          </Button>
        </>
      );
    case "lapsed":
      return (
        <>
          <Text size="xs" tone="warning">
            Needs reconnecting
          </Text>
          <Button size="sm" onClick={() => open("connect")}>
            Reconnect
          </Button>
          <Button size="sm" variant="ghost" onClick={() => open("disconnect")}>
            Disconnect
          </Button>
        </>
      );
  }
}

/** The line or two under the row: what is granted, or what is wrong and how to fix it. */
function Under({ view, admin, machine }: { view: GoogleView; admin: boolean; machine: string }) {
  switch (view.kind) {
    case "no-client":
      return (
        <Text size="xs" tone="quiet">
          {admin
            ? "The hub needs a Google OAuth client first: a one-time setup in Administration › Google."
            : "An admin sets up the hub's Google OAuth client once, in Administration › Google; then you connect here."}
        </Text>
      );
    case "not-held":
      return (
        <Text size="sm" tone="warning">
          {`${machine} doesn't hold the hub's Google client: it was offline when the client was saved. ${admin ? "Save the client again in Administration › Google while it is online." : "Ask an admin to save it again while it is online."}`}
        </Text>
      );
    case "none":
      return null;
    case "connected":
      return (
        <>
          <Text size="xs" tone="quiet">
            {`Connected ${dayWords(view.account.connectedAt)}. Sends, invitations, uploads and shares ask you first.`}
          </Text>
          <Text size="xs" tone="faint" mono className={s.granted} aria-label="Granted" data-text="code">
            {grantedNames(view.account.scopes).join(" · ") || "Only the account's address"}
          </Text>
          {view.missing.length === 0 ? null : (
            <Text size="sm" tone="warning">
              {`Without ${listWords(view.missing)}: unticked on Google's page. Reconnect and leave every box ticked.`}
            </Text>
          )}
        </>
      );
    case "lapsed":
      return (
        <>
          <Text size="sm" tone="warning">
            {lapsedLine(view.why)}
          </Text>
          <Text size="xs" tone="quiet">
            Reconnect to sign in again. Until then, Navi has no Google tools and sends nothing.
          </Text>
        </>
      );
  }
}

/** Before: what Google will ask, and help for its pages. Then: waiting on the browser. Then: done, or why not. */
function ConnectGoogle(props: { projectRef: Ref; info: GoogleGetOutput; again: boolean; onClose: () => void; onDone: (next: string | null) => void }) {
  const { hub } = useDataLayer();
  const refetch = useRefetch();
  const [phase, setPhase] = useState<"ready" | "waiting">("ready");
  const [problem, setProblem] = useState<string | null>(null);
  const waiting = phase === "waiting";
  const purposes = [...new Set(props.info.scopes.map(scopeFor).filter((x) => x !== ""))];
  const go = () => {
    setPhase("waiting");
    setProblem(null);
    void window.fleetd.google.connect(hub, { project: props.projectRef }).then(
      (out) => {
        refetch(["google_get"]);
        if (out.ok) {
          props.onDone((out.output as GoogleConnectOutput).next ?? null);
          return;
        }
        setPhase("ready");
        // Cancel is the person's own doing: nothing to explain.
        if (out.error.code !== "cancelled") setProblem(errorText(new CallError(out.error)));
      },
      (e: unknown) => {
        setPhase("ready");
        setProblem(errorText(e));
      },
    );
  };
  const close = () => {
    if (waiting) void window.fleetd.google.cancel();
    props.onClose();
  };
  return (
    <Dialog
      open
      wide
      onOpenChange={(o) => !o && close()}
      title={props.again ? "Reconnect Google" : "Connect Google"}
      description="Navi gets Gmail, Calendar and Drive with your account. Reads and drafts run unasked; a send, reply, invitation, upload or share asks you first, showing exactly what goes out."
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          {waiting ? null : (
            <Button variant="primary" onClick={go}>
              {problem === null ? "Continue in browser" : "Try again"}
            </Button>
          )}
        </>
      }
    >
      <div className={settings.stack}>
        {waiting ? (
          <div role="status">
            <Text strong size="sm">
              Waiting for Google…
            </Text>
            <Text as="p" size="sm" tone="quiet">
              Finish on the page that opened in your browser: choose the account, leave every box ticked and press Continue. This closes by itself once Google answers.
            </Text>
          </div>
        ) : (
          <>
            <Text size="sm">Google asks you to allow:</Text>
            <ul className={settings.steps}>
              {purposes.map((p) => (
                <li key={p}>
                  <Text size="sm">{p}</Text>
                </li>
              ))}
            </ul>
            <Text size="xs" tone="quiet">
              Leave every box ticked: without one, Navi can&rsquo;t do that part and says so. The code Google sends back goes straight to your Navi&rsquo;s machine, which keeps the tokens; they are never in a chat.
            </Text>
          </>
        )}
        <GoogleHelp />
        {problem === null ? null : (
          <div role="alert">
            <Text size="sm" tone="danger">
              {problem}
            </Text>
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** What to do about what Google shows on its own pages, which never reaches fleetd. */
function GoogleHelp() {
  const item = (title: ReactNode, text: string) => (
    <div>
      <dt>
        <Text size="xs" strong>
          {title}
        </Text>
      </dt>
      <dd>
        <Text size="xs" tone="quiet">
          {text}
        </Text>
      </dd>
    </div>
  );
  return (
    <details className={s.help}>
      <summary>
        <Text size="xs" tone="quiet">
          Seeing a warning or an error on Google&rsquo;s page?
        </Text>
      </summary>
      <dl>
        {item("“Google hasn’t verified this app”", "Expected: it's your hub's own app. Press Advanced, then Go to the app, and continue.")}
        {item("“Access blocked: … has not completed the Google verification process”", "The app is still in Testing and takes only its test users. Ask your hub's admin to publish it, so it is In production.")}
        {item("“Access blocked: … can only be used within its organization”", "The app is Internal: sign in with an account in that Google Workspace.")}
        {item(<>“Error 400: <span data-text="code">redirect_uri_mismatch</span>”</>, "The hub's client isn't a Desktop app client. Ask an admin to make one in Administration › Google.")}
        {item(<>“Error 401: <span data-text="code">invalid_client</span>” or “<span data-text="code">deleted_client</span>”</>, "The hub's client was deleted, or its ID is wrong. Ask an admin to test it in Administration › Google.")}
      </dl>
    </details>
  );
}

function Disconnect(props: { projectRef: Ref; email: string; machine: string; onClose: () => void; onDone: (next: string | null) => void }) {
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const go = () => {
    setBusy(true);
    setProblem(null);
    hubCall("google_disconnect", { project: props.projectRef }).then(
      (out: GoogleDisconnectOutput) => {
        setBusy(false);
        refetch(["google_get"]);
        props.onDone(out.next ?? null);
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
      title="Disconnect Google?"
      description={`Navi starts without its Google tools from its next message. fleetd deletes its tokens from ${props.machine} and revokes its access at Google, unless another Navi uses ${props.email}.`}
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
      {problem === null ? null : (
        <div role="alert">
          <Text tone="danger">{problem}</Text>
        </div>
      )}
    </Dialog>
  );
}

const RULES: ReadonlyArray<{ value: MailWakeRule; label: string }> = [
  { value: "off", label: "Off" },
  { value: "all", label: "All new mail" },
  { value: "query", label: "Matching a search" },
];

/**
 * When new mail wakes the Navi (google_mail_set): off, the default; every new message; or mail matching a Gmail
 * search. Off and All save at once; a search saves with its button. While on, how mail arrives: push, or checking each
 * minute and why (google_get's mailMode and mailProblem).
 */
function MailWakeControl({ projectRef, info, wake }: { projectRef: Ref; info: GoogleGetOutput; wake: MailWake | undefined }) {
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const saved: MailWakeRule = wake?.rule ?? "off";
  const [rule, setRule] = useState<MailWakeRule>(saved);
  const [query, setQuery] = useState(wake?.query ?? "");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const save = (next: MailWakeRule, q?: string) => {
    setBusy(true);
    setSaid(null);
    hubCall("google_mail_set", { project: projectRef, rule: next, ...(q === undefined ? {} : { query: q }) }).then(
      (out) => {
        setBusy(false);
        setSaid({ ok: true, text: out.next ?? "Saved." });
        refetch(["google_get"]);
      },
      (e: unknown) => {
        setBusy(false);
        setRule(saved);
        setSaid({ ok: false, text: errorText(e) });
      },
    );
  };
  const pick = (next: MailWakeRule) => {
    setRule(next);
    setSaid(null);
    if (next !== "query" && next !== saved) save(next);
  };
  const issue = rule === "query" && query.trim() !== "" ? queryProblem(query) : null;
  const changed = rule === "query" && (saved !== "query" || query.trim() !== (wake?.query ?? ""));
  const mode = mailModeLine(info);
  return (
    <div className={s.mail} role="group" aria-label="New mail">
      <div className={s.mailHead}>
        <Text size="xs" tone="quiet">
          New mail wakes this Navi
        </Text>
        <Segmented label="New mail wakes this Navi" options={RULES} value={rule} disabled={busy} onChange={pick} />
      </div>
      {rule !== "query" ? null : (
        <div className={s.mailQuery}>
          <Field label="Gmail search" error={issue}>
            <Input
              mono
              aria-label="Gmail search"
              value={query}
              disabled={busy}
              spellCheck={false}
              placeholder="from:boss@example.com OR is:important"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && changed && queryProblem(query) === null) save("query", query.trim());
              }}
            />
          </Field>
          {changed ? (
            <span>
              <Button size="sm" disabled={busy || queryProblem(query) !== null} onClick={() => save("query", query.trim())}>
                {busy ? "Saving…" : "Save"}
              </Button>
            </span>
          ) : null}
        </div>
      )}
      {saved === "off" ? null : (
        <Text size="xs" tone={mode.tone}>
          {mode.text}
        </Text>
      )}
      {said === null ? null : (
        <div role={said.ok ? "status" : "alert"}>
          <Text size="xs" tone={said.ok ? "quiet" : "danger"}>
            {said.text}
          </Text>
        </div>
      )}
    </div>
  );
}
