// Google's sign-in, one flow wherever it is offered: a machine's page, Settings › Hub › Providers' Google row, and
// beside a model picker whose pick is one of Google's while Google isn't connected (GoogleConnect). Sign in asks the
// machine (machine_antigravity_login), which says the plan it is signed in on, or starts `agy acp --login` (installing
// agy first where there is none) and answers the Google page to sign in at. The person opens it on this device and
// pastes the code it shows; only that code passes through the hub, once, and the sign-in stays on the machine. Where
// Google is connected comes from antigravity_status; a hub that doesn't serve it yet offers the sign-in on each machine
// that can take it (machine_roles), which says at once when one already is.
import { useEffect, useRef, useState } from "react";
import type { AntigravityStatusOutput, ProjectRef } from "../../../shared/contracts";
import { googleConnected } from "../../../shared/agentProviders";
import { FLEETD } from "../../../shared/provided";
import { RUNNER_ID } from "../../../shared/providers";
import { useCloudTeam, useData, useDataLayer, useHub, useToolQuery } from "../../src/data/react";
import { CallError } from "../../src/data/queries";
import { CLOUD_NOT_READY, ConfirmRemove, MissingOn, Problem, useMachines } from "./claudeParts";
import { sealedLine } from "./claudeModel";
import { settingsPath } from "../../../shared/settingsPages";
import { Button, copyText, Field, Input, Text, Truncate } from "../../ui";
import { MACHINE_WAIT_MS } from "../admin/machines";
import { useAdministers } from "../admin/role";
import { openExternal } from "../prs/PrDetail";
import { navigate } from "../shell/navigation";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import { revealNext } from "./reveal";
import { SettingsRow } from "./parts";
import a from "../admin/admin.module.css";
import s from "./settings.module.css";

const noInput = {};

/** A machine's own page names the row; elsewhere it is the machine's name. */
const DEFAULT_TITLE = "Google Antigravity";
/** `lab's`, `fleetd's computers'`. */
const whose = (name: string): string => (name.endsWith("s") ? `${name}'` : `${name}'s`);

/** The row's words while a sign-in starts, until Google's link is there. */
export const STARTING = "Starting a sign-in… Google's sign-in link shows here once it's ready.";

/** A first sign-in may install agy on the machine first. */
export const AGY_SIGN_IN_WAIT_MS = 600_000;

/** The reveal key of Google's row on Settings › Hub › Providers, where every link to Google's setup lands. */
export const GOOGLE_REVEAL = "hub.providers.google";

/** A sign-in started on a machine: the page to open on this device (Open, Copy), and the code it shows. */
export function SignInForm(props: {
  url: string;
  /** Whose account to sign in with: `the Claude account lab should use`. */
  account: string;
  code: string;
  onCode: (code: string) => void;
  finishing: boolean;
  live: boolean;
  /** The submit's words, at rest and while it runs. */
  verb: [string, string];
  onSubmit: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <form
      className={a.loginForm}
      aria-label="Sign in"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmit();
      }}
    >
      <Text size="sm">{`Open this page and sign in with ${props.account}.`}</Text>
      <div className={a.link}>
        {/* An address, not words: held to the code rule, not the text one. */}
        <span className={a.url} data-text="code">
          <Truncate mono size="sm">
            {props.url}
          </Truncate>
        </span>
        <Button size="sm" onClick={() => openExternal(props.url)}>
          Open
        </Button>
        <Button size="sm" variant="quiet" onClick={() => void copyText(props.url).then(setCopied)}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <Field label="The code the page shows">
        <Input value={props.code} mono autoComplete="off" placeholder="Code" onChange={(e) => props.onCode(e.target.value)} disabled={props.finishing} />
      </Field>
      <span>
        <Button type="submit" size="sm" variant="primary" disabled={props.code.trim() === "" || props.finishing || !props.live}>
          {props.finishing ? props.verb[1] : props.verb[0]}
        </Button>
      </span>
    </form>
  );
}

type AgySignIn =
  | { readonly step: "idle" }
  | { readonly step: "starting" }
  | { readonly step: "url"; readonly url: string }
  | { readonly step: "finishing"; readonly url: string }
  | { readonly step: "signed"; readonly plan: string };

/** One machine's sign-in, as its steps; `signedIn` is what antigravity_status already said. */
function useAgySignIn(machineId: string, signedIn: string | undefined) {
  const call = useHubCall();
  const refetch = useRefetch();
  const [step, setSign] = useState<AgySignIn>({ step: "idle" });
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  // While nothing is under way, what antigravity_status says (another device may have signed it in since).
  const sign: AgySignIn = step.step === "idle" && signedIn !== undefined && error === undefined ? { step: "signed", plan: signedIn } : step;
  const start = () => {
    setError(undefined);
    setCode("");
    setSign({ step: "starting" });
    call("machine_antigravity_login", { machineId }, { timeoutMs: AGY_SIGN_IN_WAIT_MS }).then(
      (out) => {
        setSign(out.signedIn !== undefined ? { step: "signed", plan: out.signedIn } : out.loginUrl !== undefined ? { step: "url", url: out.loginUrl } : { step: "idle" });
        if (out.signedIn !== undefined) refetch(["antigravity_status"]);
      },
      (e: unknown) => {
        setError(errorText(e));
        setSign({ step: "idle" });
      },
    );
  };
  const finish = (url: string) => {
    if (code.trim() === "") return;
    setError(undefined);
    setSign({ step: "finishing", url });
    call("machine_antigravity_login", { machineId, code: code.trim() }, { timeoutMs: MACHINE_WAIT_MS }).then(
      (out) => {
        setCode("");
        setSign({ step: "signed", plan: out.signedIn ?? "Google" });
        refetch(["antigravity_status"]);
      },
      (e: unknown) => {
        setError(errorText(e));
        // A used or wrong code is spent: the sign-in has ended, so it starts again.
        setSign({ step: "idle" });
      },
    );
  };
  return { sign, code, setCode, error, start, finish };
}

/**
 * Google's sign-in on one machine, as a row: its title (Google Antigravity on a machine's page, the machine's name on
 * Providers), Signed in with the plan once it is, else Sign in…, its form under it while one runs. `autoStart` starts
 * the sign-in as the row shows (Providers' Sign in with Google, with one machine to sign in).
 */
export function AntigravityRow({
  machineId,
  title = DEFAULT_TITLE,
  signedIn,
  autoStart = false,
  flush = false,
}: {
  machineId: string;
  title?: string;
  signedIn?: string | undefined;
  autoStart?: boolean;
  flush?: boolean;
}) {
  const live = useLive();
  const { sign, code, setCode, error, start, finish } = useAgySignIn(machineId, signedIn);
  const started = useRef(false);
  useEffect(() => {
    if (!autoStart || started.current || !live || sign.step !== "idle") return;
    started.current = true;
    start();
  });
  const waiting = sign.step === "idle" || sign.step === "starting";
  return (
    <SettingsRow
      title={title}
      line={
        error !== undefined ? (
          <span role="alert">{error}</span>
        ) : sign.step === "signed" ? (
          `Signed in · ${sign.plan}`
        ) : !live && waiting ? (
          "Not connected to the workspace."
        ) : sign.step === "starting" ? (
          // Words while it starts, never a bare disabled button: the machine may start a computer or install agy first.
          <span role="status">{STARTING}</span>
        ) : undefined
      }
      lineTone={error === undefined ? "quiet" : "danger"}
      control={
        sign.step === "idle" ? (
          <Button size="sm" disabled={!live} onClick={start}>
            {error === undefined ? "Sign in…" : "Try again"}
          </Button>
        ) : undefined
      }
      data={{ "data-row": "antigravity", "data-machine": machineId }}
      flush={flush}
    >
      {sign.step === "url" || sign.step === "finishing" ? (
        <SignInForm
          url={sign.url}
          account={`the Google account ${whose(title === DEFAULT_TITLE ? machineId : title)} agents on Antigravity should use`}
          code={code}
          onCode={setCode}
          finishing={sign.step === "finishing"}
          live={live}
          verb={["Sign in", "Signing in…"]}
          onSubmit={() => finish(sign.url)}
        />
      ) : null}
    </SettingsRow>
  );
}

/**
 * Where Google is connected (antigravity_status), undefined while it is read, on a hub without it, or when it failed;
 * and the machines a sign-in can go to: its machines, else (an older hub) each machine that signs Antigravity in from
 * the app, as machine_roles lists them, with what's known of each.
 */
export function useGoogle(): { status: AntigravityStatusOutput | undefined; machines: { machineId: string; signedIn?: string | undefined }[] } {
  const live = useLive();
  const status = useToolQuery("antigravity_status", noInput, { enabled: live }).data;
  const roles = useToolQuery("machine_roles", noInput, { enabled: live && status === undefined }).data?.machines;
  const machines = status?.machines ?? (roles ?? []).filter((m) => m.antigravityLogin === true).map((m) => ({ machineId: m.machineId }));
  return { status, machines };
}

/** A machine's name as the team sees it, else its id; the hub's runner on a cloud team is fleetd's computers. */
export const useMachineName = () => {
  const team = useData((d) => d.machines);
  return (machineId: string): string => (team[machineId]?.runner === true || machineId === RUNNER_ID ? FLEETD : (team[machineId]?.name ?? machineId));
};

/** Opens Settings › Hub › Providers at Google's row. */
export const openGoogle = () => {
  revealNext(GOOGLE_REVEAL);
  navigate({ id: "settings", tab: "hub.providers" });
};

/**
 * Beside a model picker whose pick is one of Google's: nothing once Google is connected (for `project`, its own key
 * counts too). Otherwise one row, Google isn't connected, with Sign in with Google, which runs the sign-in right here on
 * the one machine there is to sign in (more than one, or none: Providers' Google row, which lists them); a member, who
 * can't, is told who can in the row's hover. `flush` inside a form.
 */
export function GoogleConnect({ project, flush = false }: { project?: ProjectRef | undefined; flush?: boolean }) {
  const admin = useAdministers();
  const cloud = useCloudTeam();
  const live = useLive();
  const { status, machines } = useGoogle();
  const name = useMachineName();
  const [open, setOpen] = useState(false);
  if (googleConnected(status, project) === "yes") return null;
  const unsigned = machines.filter((m) => m.signedIn === undefined);
  const only = unsigned.length === 1 ? unsigned[0] : undefined;
  if (open && only !== undefined) return <AntigravityRow machineId={only.machineId} title={name(only.machineId)} autoStart flush={flush} />;
  return (
    <SettingsRow
      title="Google isn't connected"
      hint={admin ? undefined : `An owner or admin signs Google in, or adds a Gemini key, in ${settingsPath(cloud, "Providers")}.`}
      data={{ "data-google-connect": "" }}
      flush={flush}
      control={
        admin ? (
          <span className={s.leadControl}>
            <Button size="sm" variant="quiet" disabled={!live} onClick={openGoogle}>
              Add a Gemini key
            </Button>
            <Button size="sm" disabled={!live} onClick={() => (only === undefined ? openGoogle() : setOpen(true))}>
              Sign in with Google
            </Button>
          </span>
        ) : undefined
      }
    />
  );
}

/** Where a Gemini key comes from. */
const AI_STUDIO_KEYS = "https://aistudio.google.com/apikey";

/**
 * The team's Gemini API key (gemini_key_set): sealed in the app's main process to each machine agents run on, never
 * shown again. Agents on Google whose bot has no GEMINI_API_KEY of its own run on it. Add key… opens its form in place
 * (the key, and an endpoint for a gateway of its own); once saved, where it is held, Change and Remove.
 */
export function GeminiKeyRow({ status }: { status: AntigravityStatusOutput | undefined }) {
  const { hub } = useDataLayer();
  const cloud = useHub().cloud === true;
  const machines = useMachines();
  const live = useLive();
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const key = status?.teamKey;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const changed = value.trim() !== "" || (key !== undefined && endpoint.trim() !== (key.endpoint ?? ""));
  const submit = () => {
    if (cloud && machines.boxes.length === 0 && value.trim() !== "") return setProblem(CLOUD_NOT_READY);
    setBusy(true);
    setProblem(null);
    const request = { account: "gemini" as const, ...(value.trim() === "" ? {} : { key: value }), ...(endpoint.trim() === "" ? {} : { endpoint: endpoint.trim() }), boxes: machines.boxes };
    void window.fleetd.secret
      .claudeAccount(hub, request)
      .then(
        (out) => (out.ok ? null : "problem" in out ? String(out.problem) : errorText(new CallError(out.error))),
        (e: unknown) => errorText(e),
      )
      .then((failed) => {
        setBusy(false);
        if (failed !== null) return setProblem(failed);
        setValue("");
        setEditing(false);
        refetch(["antigravity_status"]);
      });
  };
  const open = editing;
  return (
    <SettingsRow
      title="Gemini API key"
      hint="The workspace's key, from Google AI Studio: agents on Google run on it unless their bot has a key or an endpoint of its own. It is sealed to each machine and never shown again; agents on Google get it in their environment, masked in what they report, and it goes to no endpoint but Google's or the one saved here."
      line={key === undefined ? null : `${sealedLine(key.sealedOn)}${key.endpoint === undefined ? "" : ` Through ${key.endpoint}.`}`}
      data={{ "data-row": "gemini-key" }}
      control={
        editing ? undefined : key === undefined ? (
          <Button size="sm" disabled={!live} onClick={() => (setEndpoint(""), setEditing(true))}>
            Add key…
          </Button>
        ) : (
          <>
            <Button size="sm" variant="ghost" disabled={!live} onClick={() => (setEndpoint(key.endpoint ?? ""), setEditing(true))}>
              Change
            </Button>
            <Button size="sm" variant="ghost" disabled={!live} onClick={() => setRemoving(true)}>
              Remove
            </Button>
          </>
        )
      }
    >
      {key === undefined ? null : <MissingOn sealedOn={key.sealedOn} machines={machines.ids} there="its agents on Google run on their bot's key or the sign-in there" />}
      {open ? (
        <>
          <div className={s.inline}>
            <Button size="sm" variant="ghost" onClick={() => void window.fleetd.openExternal(AI_STUDIO_KEYS)}>
              Google AI Studio › API keys
            </Button>
          </div>
          <Field label="API key" description={key === undefined ? undefined : "Leave it empty to keep the saved key."}>
            <Input mono aria-label="Gemini API key" className={s.secretValue} data-secret="" value={value} disabled={busy} autoComplete="off" spellCheck={false} onChange={(e) => setValue(e.target.value)} />
          </Field>
          <Field label="Endpoint">
            <Input mono aria-label="Gemini endpoint" value={endpoint} disabled={busy} autoComplete="off" spellCheck={false} placeholder="Google's own" onChange={(e) => setEndpoint(e.target.value)} />
          </Field>
          <div className={s.inline}>
            <Button variant="primary" disabled={busy || !live || (key === undefined ? value.trim() === "" : !changed)} onClick={submit}>
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => (setEditing(false), setValue(""), setProblem(null))}>
              Cancel
            </Button>
          </div>
        </>
      ) : null}
      <Problem text={problem} />
      {removing ? (
        <ConfirmRemove
          title="Remove the workspace's Gemini key?"
          description="Each machine forgets it. Agents on Google run on their bot's own key, else the machine's Google sign-in, from their next start."
          action="Remove"
          onRemove={() => hubCall("gemini_key_remove", {}).then(() => refetch(["antigravity_status"]))}
          onClose={() => setRemoving(false)}
        />
      ) : null}
    </SettingsRow>
  );
}
