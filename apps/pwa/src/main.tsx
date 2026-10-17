import type { Ask, AsksListOutput, DoctorCheck, DoctorFixOutput, DoctorListOutput, FleetStatus, InboxReplyOutput, Machine, SecretSubmitOutput, Step, UsageStatusOutput, UsageStatus } from "@fleetd/contracts";
import { Fragment, render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { doctorOrder, doctorTitle, withFixed } from "./doctor.ts";
import { connectHub, type Hub } from "./hub.ts";
import {
  approvalRows,
  inboxItems,
  pairingToken,
  refreshesAsks,
  replyEcho,
  secretTarget,
  statusLine,
  tapsFor,
  type Conn,
  type Echo,
  type InboxItem,
} from "./inbox.ts";
import { forgetKey, loadKey, saveKey } from "./keystore.ts";
import { currentSubscription, pushSupported, subscribe, unsubscribe } from "./push.ts";
import { loadSodium, sealSecret } from "./seal.ts";

type Asks = typeof AsksListOutput.Type;
type Usage = ReadonlyArray<UsageStatus>;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Runs `run` once now and once more after it if asked again meanwhile, so bursts of events cost two fetches. */
const coalesced = (run: () => Promise<void>) => {
  let busy = false;
  let again = false;
  const go = async (): Promise<void> => {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      await run();
    } finally {
      busy = false;
      if (again) {
        again = false;
        void go();
      }
    }
  };
  return go;
};

type Session = { readonly kind: "loading" } | { readonly kind: "unpaired"; readonly note?: string } | { readonly kind: "key"; readonly key: string } | { readonly kind: "pair"; readonly token: string };

const App = () => {
  const [session, setSession] = useState<Session>({ kind: "loading" });

  useEffect(() => {
    const token = pairingToken(location.hash);
    if (location.hash.startsWith("#pair=")) {
      // The token is single-use; keep it out of history and bookmarks.
      history.replaceState(null, "", location.pathname);
      if (token !== undefined) return setSession({ kind: "pair", token });
    }
    loadKey().then(
      (stored) => setSession(stored === undefined ? { kind: "unpaired" } : { kind: "key", key: stored.key }),
      (error: unknown) => setSession({ kind: "unpaired", note: `Can't read this browser's storage: ${message(error)}` }),
    );
  }, []);

  if (session.kind === "loading") return null;
  if (session.kind === "unpaired") return <Pairing note={session.note} onToken={(token) => setSession({ kind: "pair", token })} />;
  return (
    <Inbox
      start={session.kind === "key" ? { key: session.key } : { pairToken: session.token }}
      onRefused={(note) => {
        void forgetKey();
        setSession({ kind: "unpaired", note });
      }}
    />
  );
};

const Pairing = ({ note, onToken }: { note: string | undefined; onToken: (token: string) => void }) => {
  const [text, setText] = useState("");
  const token = pairingToken(text);
  return (
    <main class="pair">
      <h1>fleetd</h1>
      {note !== undefined && <p class="bad">{note}</p>}
      <p>
        Pair this device: on the hub run <code>fleetd hub device add --name phone --url {location.origin}</code> and open the link it prints here. Links last 15
        minutes and work once.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (token !== undefined) onToken(token);
        }}
      >
        <input value={text} onInput={(event) => setText(event.currentTarget.value)} placeholder="or paste the pairing link" autocomplete="off" />
        <button disabled={token === undefined}>Pair</button>
      </form>
    </main>
  );
};

const Inbox = ({ start, onRefused }: { start: { key: string } | { pairToken: string }; onRefused: (note: string) => void }) => {
  const [conn, setConn] = useState<Conn>("connecting");
  const [machines, setMachines] = useState<ReadonlyArray<Machine>>([]);
  const [asks, setAsks] = useState<Asks | undefined>();
  const [asksError, setAsksError] = useState<string | undefined>();
  const [usage, setUsage] = useState<Usage | undefined>();
  const [echo, setEcho] = useState<Echo | undefined>();
  const [busy, setBusy] = useState(false);
  const [hub, setHub] = useState<Hub | undefined>();
  /** Bumped on doctor.changed; the Doctor section refetches when it is open. */
  const [doctorTick, setDoctorTick] = useState(0);

  useEffect(() => {
    let streaming = false;
    const fetchAsks = coalesced(async () => {
      try {
        setAsks(await live.call<Asks>("asks_list", { state: "open" }));
        setAsksError(undefined);
      } catch (error) {
        setAsksError(message(error));
      }
    });
    const fetchUsage = coalesced(async () => {
      // Usage is a nicety on the status line; a key without read on it just leaves it out.
      setUsage(await live.call<typeof UsageStatusOutput.Type>("usage_status", {}).then((out) => out.machines, () => undefined));
    });
    const live = connectHub(start, {
      conn: (next) => {
        setConn(next);
        if (next !== "live") streaming = false;
      },
      ready: () => live.snapshot(),
      snapshot: (status: FleetStatus) => {
        setMachines(status.machines);
        if (!streaming) {
          streaming = true;
          live.events(status.cursor);
        }
        void fetchAsks();
        void fetchUsage();
      },
      event: (event) => {
        if (event.type.startsWith("machine.")) live.snapshot();
        if (refreshesAsks(event.type)) void fetchAsks();
        if (event.type.startsWith("usage.")) void fetchUsage();
        if (event.type === "doctor.changed") setDoctorTick((n) => n + 1);
      },
      paired: (key, keyId) => void saveKey({ key, keyId }),
      refused: onRefused,
    });
    setHub(live);
    // A tapped push notification: show the newest inbox.
    const onWorkerMessage = () => {
      window.scrollTo(0, 0);
      void fetchAsks();
    };
    navigator.serviceWorker?.addEventListener("message", onWorkerMessage);
    return () => {
      navigator.serviceWorker?.removeEventListener("message", onWorkerMessage);
      live.close();
    };
  }, []);

  const reply = async (raw: string, batchId?: string) => {
    if (hub === undefined) return;
    setBusy(true);
    try {
      setEcho(replyEcho(await hub.call<typeof InboxReplyOutput.Type>("inbox_reply", batchId === undefined ? { raw } : { raw, batchId })));
      setAsks(await hub.call<Asks>("asks_list", { state: "open" }));
      return true;
    } catch (error) {
      setEcho({ text: message(error), ok: false });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const items = asks === undefined ? [] : inboxItems(asks.batches, asks.asks);
  let lastBatch = "";
  return (
    <>
      <header>
        <span class="status">{statusLine(conn, machines, items.length, usage)}</span>
        {hub !== undefined && conn === "live" && <PushToggle hub={hub} />}
      </header>
      <main>
        {echo !== undefined && <p class={echo.ok ? "good" : "bad"}>{echo.text}</p>}
        {asksError !== undefined && <p class="bad">{asksError}</p>}
        {asks !== undefined && items.length === 0 && (
          <p class="muted">Nothing needs you. Leads decide everything that isn't a product, money, credential or irreversible call.</p>
        )}
        {items.map((item) => {
          const heading = item.batchId !== lastBatch ? <h2 class="muted">Batch {item.batchId}</h2> : null;
          lastBatch = item.batchId;
          return (
            <Fragment key={item.ask.askId}>
              {heading}
              <Card item={item} machines={machines} hub={hub} busy={busy} onTap={(raw) => void reply(raw, item.batchId)} onEcho={setEcho} />
            </Fragment>
          );
        })}
        {hub !== undefined && conn === "live" && <Doctor hub={hub} tick={doctorTick} />}
      </main>
      <ReplyBox disabled={busy || conn !== "live"} onSend={reply} />
    </>
  );
};

interface CardProps {
  readonly item: InboxItem;
  readonly machines: ReadonlyArray<Machine>;
  readonly hub: Hub | undefined;
  readonly busy: boolean;
  readonly onTap: (raw: string) => void;
  readonly onEcho: (echo: Echo) => void;
}

const Card = ({ item, machines, hub, busy, onTap, onEcho }: CardProps) => {
  const { ask, number } = item;
  return (
    <article class={`card ${ask.class}`}>
      <div class="meta">
        <b>{number}</b>
        <span class="class">{ask.class}</span>
        <span class="muted">{ask.projectRef === undefined ? "no project yet" : `${ask.projectRef.machineId}/${ask.projectRef.projectId}`}</span>
        {ask.blocks !== "nothing" && <span class="warn">blocks: {ask.blocks}</span>}
        {ask.proceededOnRec && <span class="muted">went ahead on the recommendation</span>}
      </div>
      <p>{ask.text}</p>
      {ask.evidence !== undefined && <pre class="evidence">{ask.evidence}</pre>}
      {ask.kind === "do" && ask.steps !== undefined && <Steps steps={ask.steps} />}
      {ask.kind === "approve" && ask.gated !== undefined && (
        <dl class="gated">
          {approvalRows(ask.gated).map(([label, value]) => (
            <Fragment key={label}>
              <dt>{label}</dt>
              <dd>{label === "argv" || label === "cwd" ? <code>{value}</code> : value}</dd>
            </Fragment>
          ))}
        </dl>
      )}
      {ask.kind === "secret" && hub !== undefined && <SecretEntry ask={ask} machines={machines} hub={hub} onSaved={onEcho} />}
      <div class="taps">
        {tapsFor(ask, number).map((tap) => (
          <button key={tap.raw} class={tap.tone} disabled={busy} onClick={() => onTap(tap.raw)}>
            {tap.label}
          </button>
        ))}
      </div>
    </article>
  );
};

const Steps = ({ steps }: { steps: ReadonlyArray<Step> }) => {
  const [copied, setCopied] = useState<number | undefined>();
  return (
    <ol class="steps">
      {steps.map((step, i) => (
        <li key={i}>
          {step.text} <span class="muted">[{step.where}]</span>
          {step.command !== undefined && (
            <div class="cmd">
              <code>{step.command}</code>
              <button
                class="plain"
                onClick={() =>
                  void navigator.clipboard.writeText(step.command!).then(() => {
                    setCopied(i);
                    setTimeout(() => setCopied((now) => (now === i ? undefined : now)), 1500);
                  })
                }
              >
                {copied === i ? "Copied" : "Copy"}
              </button>
            </div>
          )}
          {step.expect !== undefined && <div class="muted">expect: {step.expect}</div>}
        </li>
      ))}
    </ol>
  );
};

/**
 * Masked entry. The input is uncontrolled so the value never lands in component state; it is read once, cleared
 * from the DOM, encoded to bytes that sealSecret wipes. The one JS string the read creates can't be wiped; it is
 * dropped at once.
 */
const SecretEntry = ({ ask, machines, hub, onSaved }: { ask: Ask; machines: ReadonlyArray<Machine>; hub: Hub; onSaved: (echo: Echo) => void }) => {
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<{ readonly busy: boolean; readonly error?: string }>({ busy: false });
  const target = secretTarget(ask, machines);
  const submit = async () => {
    if (!target.ok || input.current === null || input.current.value === "") return;
    setState({ busy: true });
    try {
      // Load first, so the value is read, cleared and sealed in one synchronous step.
      const lib = await loadSodium();
      const field = input.current;
      const sealed = sealSecret(lib, target.boxPubKey, new TextEncoder().encode(field.value));
      field.value = "";
      const out = await hub.call<typeof SecretSubmitOutput.Type>("secret_submit", { askId: ask.askId, sealed });
      // The ask closes and its card goes, so the fingerprint is shown at the top of the inbox.
      onSaved({ ok: true, text: `${ask.key} saved on ${target.machineId}, fingerprint ${out.fingerprint}` });
      setState({ busy: false });
    } catch (error) {
      if (input.current !== null) input.current.value = "";
      setState({ busy: false, error: message(error) });
    }
  };
  return (
    <form
      class="secret"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div class="muted">
        <code>{ask.key}</code> → <code>{ask.sink}</code>
      </div>
      {target.ok ? (
        <div class="row">
          <input ref={input} type="password" autocomplete="off" autocapitalize="off" spellcheck={false} placeholder="Value" disabled={state.busy} />
          <button class="go" disabled={state.busy}>
            {state.busy ? "Sealing…" : "Seal & send"}
          </button>
        </div>
      ) : (
        <p class="warn">{target.reason}</p>
      )}
      <p class="muted">Encrypted here to {target.ok ? target.machineId : "the machine"}'s key; the hub never sees it.</p>
      {state.error !== undefined && <p class="bad">{state.error}</p>}
    </form>
  );
};

/** The hub's setup checks, fetched when opened; Fix runs a check's automatic fix (doctor_fix). */
const Doctor = ({ hub, tick }: { hub: Hub; tick: number }) => {
  const [open, setOpen] = useState(false);
  const [checks, setChecks] = useState<ReadonlyArray<DoctorCheck> | undefined>();
  const [note, setNote] = useState<Echo | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const load = async (rerun: boolean) => {
    if (rerun) setBusy("rerun");
    try {
      setChecks((await hub.call<typeof DoctorListOutput.Type>("doctor_list", rerun ? { rerun: true } : {})).checks);
    } catch (error) {
      setNote({ ok: false, text: message(error) });
    } finally {
      if (rerun) setBusy(undefined);
    }
  };
  useEffect(() => {
    if (open) void load(false);
  }, [open, tick]);
  const fix = async (checkId: string) => {
    setBusy(checkId);
    setNote(undefined);
    try {
      const out = await hub.call<typeof DoctorFixOutput.Type>("doctor_fix", { checkId });
      setChecks((now) => (now === undefined ? now : withFixed(now, out.check)));
      setNote({ ok: out.check.status === "ok", text: `${out.ran}. ${out.next ?? ""}`.trim() });
    } catch (error) {
      setNote({ ok: false, text: message(error) });
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <details class="doctor" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{doctorTitle(checks)}</summary>
      {note !== undefined && <p class={note.ok ? "good" : "bad"}>{note.text}</p>}
      {checks === undefined && open && <p class="muted">Checking…</p>}
      {checks !== undefined &&
        doctorOrder(checks).map((check) => (
          <div key={check.id} class="check">
            <span class={`dot ${check.status}`} title={check.status} />
            <div>
              <code>{check.id}</code> {check.message}
              {check.fix !== undefined && check.status !== "ok" && (
                <div class="muted">
                  {check.fix.label}
                  {check.fix.command !== undefined && (
                    <div class="cmd">
                      <code>{check.fix.command}</code>
                    </div>
                  )}
                </div>
              )}
            </div>
            {check.fix?.kind === "auto" && check.status !== "ok" && (
              <button class="go" disabled={busy !== undefined} onClick={() => void fix(check.id)}>
                {busy === check.id ? "Fixing…" : "Fix"}
              </button>
            )}
          </div>
        ))}
      {open && (
        <button class="plain" disabled={busy !== undefined} onClick={() => void load(true)}>
          {busy === "rerun" ? "Checking…" : "Check again"}
        </button>
      )}
    </details>
  );
};

const ReplyBox = ({ disabled, onSend }: { disabled: boolean; onSend: (raw: string) => Promise<boolean | undefined> }) => {
  const [raw, setRaw] = useState("");
  return (
    <form
      class="reply"
      onSubmit={(event) => {
        event.preventDefault();
        if (raw.trim() !== "") void onSend(raw.trim()).then((sent) => sent === true && setRaw(""));
      }}
    >
      <input value={raw} onInput={(event) => setRaw(event.currentTarget.value)} placeholder="1 go 2 nvm 3 b · recs fine" autocomplete="off" autocapitalize="off" />
      <button disabled={disabled || raw.trim() === ""}>Send</button>
    </form>
  );
};

const PushToggle = ({ hub }: { hub: Hub }) => {
  const [sub, setSub] = useState<PushSubscription | null | undefined>();
  const [note, setNote] = useState<string | undefined>();
  useEffect(() => {
    if (pushSupported()) currentSubscription().then(setSub, (error: unknown) => setNote(message(error)));
  }, []);
  if (!pushSupported()) {
    // iOS offers Web Push only to a site added to the Home Screen.
    return /iPhone|iPad/u.test(navigator.userAgent) ? <span class="muted">Add to Home Screen for push</span> : null;
  }
  const toggle = async () => {
    setNote(undefined);
    try {
      if (sub === null) await subscribe(hub);
      else if (sub !== undefined) await unsubscribe(hub, sub);
      setSub(await currentSubscription());
    } catch (error) {
      setNote(message(error));
    }
  };
  return (
    <>
      {note !== undefined && <span class="bad">{note}</span>}
      <button class="plain" disabled={sub === undefined} onClick={() => void toggle()}>
        {sub ? "Push on ✓" : "Turn on push"}
      </button>
    </>
  );
};

if ("serviceWorker" in navigator && window.isSecureContext) void navigator.serviceWorker.register("/sw.js");
render(<App />, document.getElementById("app")!);
