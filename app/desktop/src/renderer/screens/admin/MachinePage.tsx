// Settings › Hub › Machines › one machine (#/settings/hub/machines/<id>): what it needs once it has joined, as a checklist
// read from the hub's own checks (doctor_list, refetched on doctor.changed): claude installed and logged in, the git
// identity its commits carry, GitHub access, and the sessions it can host. Each item that wants a look has its fix: a
// command to run on the machine, with Copy, or for claude's login, Log in, which runs `claude auth login` on the
// machine through its node. The person signs in on their own device and pastes the code the page shows; the token
// stays on the machine. A machine just joined, which the hub hasn't checked yet, is checked as its page opens.
import { useEffect, useRef, useState } from "react";
import type { DoctorFix } from "../../../shared/contracts";
import { callKey } from "../../src/data/queries";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { Button, copyText, Field, Input, StateGlyph, Text, Truncate, toast, type GlyphState } from "../../ui";
import { openExternal } from "../prs/PrDetail";
import { HubText } from "../projects/HubText";
import { errorText, useHubCall, useLive } from "../settings/hub";
import { revealNext } from "../settings/search";
import { PageHead } from "../settings/parts";
import { RunOn } from "../setup/Guide";
import { toHash } from "../shell/routes";
import { checklistOf, MACHINE_WAIT_MS, type ChecklistItem, type ItemState } from "./machines";
import s from "../settings/settings.module.css";
import a from "./admin.module.css";

const allChecks = {};

const GLYPH: Readonly<Record<ItemState, GlyphState>> = { done: "done", failed: "failed", warn: "waiting", waiting: "queued" };

export function MachinePage({ machineId }: { machineId: string }) {
  const machine = useData((d) => d.machines[machineId]);
  const fresh = useData((d) => d.fresh);
  const checks = useToolQuery("doctor_list", allChecks);
  const layer = useDataLayer();
  const [rerunning, setRerunning] = useState(false);
  const back = () => (window.location.hash = toHash({ id: "settings", tab: "hub.machines" }));

  const rerun = async () => {
    setRerunning(true);
    const out = await layer.call("doctor_list", { rerun: true }, { timeoutMs: 120_000 });
    setRerunning(false);
    if (out.ok) layer.queryClient.setQueryData(callKey("doctor_list", allChecks), out.output);
    else toast({ title: "The checks didn't run", description: out.error.message, tone: "danger" });
  };

  // A machine that has just joined (or whose node linked after the hub's last round) has no checks yet, or some the
  // hub couldn't answer: the hub checks it now, rather than the page waiting for its next round. Once per page.
  const checked = useRef(false);
  const mine = checks.data?.checks.filter((c) => c.machineId === machineId);
  const unchecked = machine !== undefined && machine.status !== "offline" && mine !== undefined && (mine.length === 0 || mine.some((c) => c.status === "unknown"));
  useEffect(() => {
    if (!unchecked || checked.current) return;
    checked.current = true;
    void rerun();
    // Only when it turns unchecked: rerun is the same call each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unchecked]);

  const items = checks.data === undefined ? undefined : checklistOf(checks.data.checks, machineId);
  const status = machine === undefined ? undefined : machine.status === "online" ? "Online" : machine.status === "degraded" ? "Degraded" : "Offline";
  return (
    <div className={s.scroll} data-screen="settings.hub.machine">
      <div className={s.column}>
        <span>
          <Button variant="link" size="sm" onClick={back}>
            ← Machines
          </Button>
        </span>
        <PageHead title={machine?.name ?? machineId}>
          {machine === undefined
            ? fresh
              ? "This hub has no such machine. It may have been removed."
              : "Loading…"
            : `${status ?? ""} · fleetd ${machine.nodeVersion}. What it needs to run agents, as the hub last checked.`}
        </PageHead>
        {machine === undefined ? null : (
          <section className={a.section} aria-label="Checklist">
            <div className={a.checklistHead}>
              <Text strong>Checklist</Text>
              <Button variant="ghost" size="sm" disabled={rerunning} onClick={() => void rerun()}>
                {rerunning ? "Checking…" : "Check again"}
              </Button>
            </div>
            {checks.error ? (
              <Text tone="danger">{`Couldn't read the checks: ${errorText(checks.error)}`}</Text>
            ) : items === undefined ? (
              <Text tone="quiet">Loading…</Text>
            ) : (
              <ol className={a.checklist}>
                {items.map((item) => (
                  <Item key={item.key} item={item} machineId={machineId} name={machine.name} onLoggedIn={() => void rerun()} />
                ))}
              </ol>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function Item({ item, machineId, name, onLoggedIn }: { item: ChecklistItem; machineId: string; name: string; onLoggedIn: () => void }) {
  return (
    <li className={a.item} data-item={item.key} data-state={item.state}>
      <StateGlyph state={GLYPH[item.state]} size="sm" />
      <div className={a.itemBody}>
        <Text strong={item.state === "failed" || item.state === "warn"} tone={item.state === "failed" ? "danger" : item.state === "warn" ? "warning" : "default"}>
          {item.title}
        </Text>
        {item.lines.map((line) => (
          <Text key={line} size="sm" tone="quiet">
            <HubText>{line}</HubText>
          </Text>
        ))}
        {item.login ? <ClaudeLogin machineId={machineId} onLoggedIn={onLoggedIn} /> : item.fix ? <Fix fix={item.fix} where={name} /> : null}
        {item.screens === true ? (
          <span>
            <Button
              variant="link"
              size="sm"
              onClick={() => {
                revealNext("hub.screens");
                window.location.hash = toHash({ id: "settings", tab: "hub.machines" });
              }}
            >
              Turn them on under Screens
            </Button>
          </span>
        ) : null}
      </div>
    </li>
  );
}

/** The hub's fix: what to do, and the command to run on the machine, with Copy. */
function Fix({ fix, where }: { fix: DoctorFix; where: string }) {
  return (
    <div className={a.fix}>
      {fix.label ? (
        <Text size="sm">
          <HubText>{fix.label}</HubText>
        </Text>
      ) : null}
      {fix.command ? <RunOn where={where} command={fix.command} /> : null}
    </div>
  );
}

type Login =
  | { readonly step: "idle" }
  | { readonly step: "starting" }
  | { readonly step: "url"; readonly url: string }
  | { readonly step: "finishing"; readonly url: string }
  | { readonly step: "done"; readonly message: string };

/**
 * Claude's login from here: Log in starts `claude auth login` on the machine (machine_claude_login), which answers the
 * page to sign in at. The person opens it on this device, signs in with the account the machine should use, and
 * pastes the code the page shows. Only that code passes through the hub, once; the token stays on the machine.
 */
export function ClaudeLogin({ machineId, onLoggedIn }: { machineId: string; onLoggedIn: () => void }) {
  const call = useHubCall();
  const live = useLive();
  const [login, setLogin] = useState<Login>({ step: "idle" });
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);

  const start = () => {
    setError(undefined);
    setCode("");
    setLogin({ step: "starting" });
    call("machine_claude_login", { machineId }, { timeoutMs: MACHINE_WAIT_MS }).then(
      (out) => setLogin(out.loginUrl === undefined ? { step: "idle" } : { step: "url", url: out.loginUrl }),
      (e: unknown) => {
        setError(errorText(e));
        setLogin({ step: "idle" });
      },
    );
  };
  const finish = (url: string) => {
    if (code.trim() === "") return;
    setError(undefined);
    setLogin({ step: "finishing", url });
    call("machine_claude_login", { machineId, code: code.trim() }, { timeoutMs: MACHINE_WAIT_MS }).then(
      (out) => {
        setCode("");
        setLogin({ step: "done", message: out.message });
        onLoggedIn();
      },
      (e: unknown) => {
        setError(errorText(e));
        // A used or wrong code is spent: the login has ended, so it starts again.
        setLogin({ step: "idle" });
      },
    );
  };

  return (
    <div className={a.login} aria-label="Claude login">
      {login.step === "done" ? (
        <Text size="sm">{`Logged in on ${machineId}. ${login.message}`}</Text>
      ) : login.step === "idle" || login.step === "starting" ? (
        <span>
          <Button size="sm" variant="secondary" disabled={!live || login.step === "starting"} onClick={start}>
            {login.step === "starting" ? `Starting claude auth login on ${machineId}…` : error === undefined ? "Log in…" : "Try again"}
          </Button>
        </span>
      ) : (
        <form
          className={a.loginForm}
          aria-label="Sign in"
          onSubmit={(e) => {
            e.preventDefault();
            finish(login.url);
          }}
        >
          <Text size="sm">{`1. Open this page and sign in with the Claude account ${machineId} should use.`}</Text>
          <div className={a.link}>
            {/* An address, not words: held to the code rule, not the text one. */}
            <span className={a.url} data-text="code">
              <Truncate mono size="sm">
                {login.url}
              </Truncate>
            </span>
            <Button size="sm" onClick={() => openExternal(login.url)}>
              Open
            </Button>
            <Button size="sm" variant="quiet" onClick={() => void copyText(login.url).then(setCopied)}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <Field label="2. Paste the code the page shows" description="It goes to the machine once; claude keeps its login there.">
            <Input value={code} mono autoComplete="off" placeholder="Code" onChange={(e) => setCode(e.target.value)} disabled={login.step === "finishing"} />
          </Field>
          <span>
            <Button type="submit" size="sm" variant="primary" disabled={code.trim() === "" || login.step === "finishing" || !live}>
              {login.step === "finishing" ? "Logging in…" : "Log in"}
            </Button>
          </span>
        </form>
      )}
      {error === undefined ? null : (
        <p role="alert">
          <Text size="sm" tone="danger">
            {error}
          </Text>
        </p>
      )}
    </div>
  );
}
