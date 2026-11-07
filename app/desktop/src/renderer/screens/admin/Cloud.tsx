// Cloud machines on boat.dev (D306), in Settings › Hub › Machines and the setup step: the boat.dev group beside the
// person's own machines (each machine's state, what runs there and its spend today, Reset for a broken one, and the
// kill switch), then the settings, in the same rows as the page's other settings: the hub's boat.dev key (made by the
// hub once the person signs in with boat, or pasted and sealed in main to the hub's own key, never shown again) with
// Test, the way cloud machines reach the hub (the hub's own SSH tunnel to each, so the hub stays private, and the Test
// of that whole way), the pool, the budgets, the projects that may use it, and what it can cost, shown before it is
// turned on. The hub's pool (cloud_get) is the only source; a hub without it shows nothing here. Status's line is
// CloudStatus.tsx.
import { useEffect, useState } from "react";
import type { CloudView, ToolOutput } from "../../../shared/contracts";
import { callKey } from "../../src/data/queries";
import { useDataLayer, useHub } from "../../src/data/react";
import { Button, Checkbox, Dialog, Field, Input, Select, Switch, Text, toast } from "../../ui";
import { errorText, useHubCall, useRefetch } from "../settings/hub";
import { PagePart, Setting, useProjects } from "../settings/parts";
import { awakeCount, cloudStatusLine, costPreview, heldLine, machineLine, money, parseDollars, rate, resettable, stateTone, stateWord, stopAllLine } from "./cloudModel";
import { useNow } from "../live";
import { useCloud } from "./useCloud";
import { HubText } from "../projects/HubText";
import s from "../settings/settings.module.css";
import a from "./admin.module.css";

const noInput = {};

export { useCloud };

/** Keeps the pool a call answered with, so every view of it agrees at once. */
function useKeep(): (cloud: CloudView) => void {
  const data = useDataLayer();
  return (cloud) => data.queryClient.setQueryData<ToolOutput<"cloud_get">>(callKey("cloud_get", noInput), { cloud });
}

/** The boat.dev group in the list of the hub's machines: nothing until a key is saved. */
export function CloudGroup() {
  const cloud = useCloud();
  const nowMs = useNow(true, 60_000);
  const [stopping, setStopping] = useState(false);
  const [reset, setReset] = useState<string | null>(null);
  if (cloud === undefined || cloud === null || !cloud.hasKey || cloud.machines.length === 0) return null;
  const status = cloudStatusLine(cloud);
  const held = heldLine(cloud);
  return (
    <section className={`${a.section} ${a.machines}`} aria-labelledby="cloud-machines-list" data-cloud-group="">
      <div className={a.groupHead}>
        <div className={a.who}>
          <Text strong id="cloud-machines-list">
            boat.dev
          </Text>
          <Text size="xs" tone="quiet">
            {status === null ? "Cloud machines" : `${status}${cloud.enabled ? "" : ": no work goes to them"}`}
          </Text>
        </div>
        {cloud.enabled || awakeCount(cloud) > 0 ? (
          <Button size="sm" variant="ghost" className={a.danger} onClick={() => setStopping(true)}>
            Stop all cloud machines
          </Button>
        ) : null}
      </div>
      {held === null ? null : (
        <Text size="xs" tone="warning">
          <HubText>{held}</HubText>
        </Text>
      )}
      <div className={a.list} role="list" aria-label="Cloud machines">
        {cloud.machines.map((m) => (
          <div key={m.machineId} className={a.row} role="listitem" aria-label={m.machineId} data-cloud-machine={m.machineId} data-state={m.state}>
            <div className={a.who}>
              <div className={a.name}>
                <Text strong>{m.machineId}</Text>
                <Text size="xs" tone={stateTone(m.state)}>
                  {stateWord(m.state)}
                </Text>
              </div>
              <Text size="xs" tone={m.state === "broken" || m.state === "failed" ? "default" : "quiet"}>
                {machineLine(m, nowMs)}
              </Text>
            </div>
            <div className={a.controls}>
              {resettable(m.state) ? (
                <Button size="sm" variant="ghost" onClick={() => setReset(m.machineId)}>
                  Reset
                </Button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      {stopping ? <StopAll cloud={cloud} onClose={() => setStopping(false)} /> : null}
      {reset === null ? null : <ResetDialog machineId={reset} onClose={() => setReset(null)} />}
    </section>
  );
}

/** The kill switch: it names what is awake, and asks boat.dev itself for every machine with the hub's label. */
function StopAll({ cloud, onClose }: { cloud: CloudView; onClose: () => void }) {
  const call = useHubCall();
  const refetch = useRefetch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const stop = () => {
    setBusy(true);
    setError(undefined);
    call("cloud_stop", {}, { timeoutMs: 100_000 })
      .then(
        (out) => {
          onClose();
          refetch(["cloud_get", "setup_list"]);
          toast({
            title: out.stopped.length === 0 ? "Cloud machines are off" : `Stopped ${out.stopped.join(", ")}`,
            description: out.failed.length > 0 ? `Not stopped: ${out.failed.join("; ")}. Their leases stop them within 30 minutes.` : "No work goes to them until you turn them on again.",
            tone: out.failed.length > 0 ? "warning" : "success",
          });
        },
        (e: unknown) => setError(errorText(e)),
      )
      .finally(() => setBusy(false));
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !busy && onClose()}
      title="Stop all cloud machines?"
      description={stopAllLine(cloud)}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy} onClick={stop}>
            {busy ? "Stopping…" : "Stop all"}
          </Button>
        </>
      }
    >
      {error === undefined ? null : (
        <p role="alert">
          <Text size="sm" tone="danger">{`Not stopped: ${error}`}</Text>
        </p>
      )}
    </Dialog>
  );
}

function ResetDialog({ machineId, onClose }: { machineId: string; onClose: () => void }) {
  const call = useHubCall();
  const keep = useKeep();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const reset = () => {
    setBusy(true);
    setError(undefined);
    call("cloud_reset", { machineId }, { timeoutMs: 100_000 })
      .then(
        (out) => {
          keep(out.cloud);
          onClose();
          // Deleted, but making it again may wait (cloud machines off, a budget spent): the hub says so.
          toast({ title: `Reset ${machineId}`, description: out.said, tone: out.said.includes("waits") ? "warning" : "success" });
        },
        (e: unknown) => setError(errorText(e)),
      )
      .finally(() => setBusy(false));
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !busy && onClose()}
      title={`Reset ${machineId}?`}
      description={`boat.dev deletes ${machineId} with its disk: its worktrees, caches and the secrets sealed there. Then the hub makes it again, which spends one start, and it joins in a few minutes. Work pushed to GitHub is safe.`}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy} onClick={reset}>
            {busy ? "Resetting…" : `Reset ${machineId}`}
          </Button>
        </>
      }
    >
      {error === undefined ? null : (
        <p role="alert">
          <Text size="sm" tone="danger">{`Not reset: ${error}`}</Text>
        </p>
      )}
    </Dialog>
  );
}

/** Settings › Hub › Machines › Cloud machines: a part of the page, as Screens and Max agents are. */
export function CloudPart() {
  const cloud = useCloud();
  if (cloud === null) return null;
  return (
    <PagePart
      title="Cloud machines"
      reveal="hub.cloud"
      intro="When every machine here is at its agent limit, work runs on a few sleeping boat.dev machines of your own account, within budgets you set."
    >
      {cloud === undefined ? <Text tone="quiet">Loading…</Text> : <CloudSettings cloud={cloud} />}
    </PagePart>
  );
}

const DOCS = "https://fleetd.sh/docs/cloud-machines/";

/** The cloud machines' settings, here and inline in the setup step. */
export function CloudSettings({ cloud }: { cloud: CloudView }) {
  return (
    <>
      <Text size="sm" tone="quiet">
        Cloud machines run on boat.dev: boat.dev can see what runs on them, as any host can.{" "}
        <button type="button" className={a.textLink} onClick={() => void window.fleetd.openExternal(DOCS)}>
          What it costs and what boat.dev sees
        </button>
      </Text>
      <KeySetting cloud={cloud} />
      <WaySetting cloud={cloud} />
      {cloud.hasKey ? <PoolSettings cloud={cloud} /> : null}
    </>
  );
}

function KeySetting({ cloud }: { cloud: CloudView }) {
  const hub = useHub();
  const call = useHubCall();
  const keep = useKeep();
  const refetch = useRefetch();
  const [editing, setEditing] = useState(false);
  // Pasting a key is the fallback to signing in with boat.
  const [pasting, setPasting] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const test = async () => {
    setBusy("test");
    setProblem(null);
    try {
      const out = await call("cloud_test", {}, { timeoutMs: 60_000 });
      keep(out.cloud);
      refetch(["setup_list"]);
    } catch (e) {
      setProblem(errorText(e));
    }
    setBusy(null);
  };
  const save = async () => {
    setBusy("save");
    setProblem(null);
    const out = await window.fleetd.secret.cloudKey(hub.id, { boxPubKey: cloud.boxPubKey, key }).catch((e: unknown) => ({ ok: false as const, error: { code: "failed", message: errorText(e) } }));
    if (!out.ok) {
      setBusy(null);
      const fix = "fix" in out.error ? out.error.fix : undefined;
      setProblem(fix === undefined ? out.error.message : `${out.error.message} ${fix}`);
      return;
    }
    // The pool as the hub has it now, key saved, whatever the Test after it does.
    const saved = (out.output as { cloud?: CloudView } | null)?.cloud;
    if (saved !== undefined) keep(saved);
    setKey("");
    setEditing(false);
    setPasting(false);
    await test();
  };
  const open = editing || !cloud.hasKey;
  const tested = cloud.keyTest;
  return (
    <Setting
      reveal="hub.cloud.key"
      label="boat.dev key"
      help="Sign in with boat and the hub makes its own key on your boat.dev account, with only the actions the setup step lists, and keeps nothing broader. Or paste a key you made. fleetd never shows it, and no machine or agent gets it."
    >
      {cloud.hasKey ? (
        <div className={s.inline}>
          <Text size="sm">Saved, sealed to the hub.</Text>
          <Button size="sm" disabled={busy !== null} onClick={() => void test()}>
            {busy === "test" ? "Testing…" : "Test"}
          </Button>
          {editing ? null : (
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              Change
            </Button>
          )}
        </div>
      ) : null}
      {cloud.hasKey && tested !== undefined ? (
        <Text size="sm" tone={tested.ok ? "success" : "danger"} data-key-test={tested.ok ? "ok" : "failed"}>
          <HubText>{tested.said}</HubText>
        </Text>
      ) : null}
      {open || cloud.signIn !== undefined ? <SignIn cloud={cloud} form={open && !pasting} onDone={() => (setEditing(false), setPasting(false))} /> : null}
      {open && !pasting && cloud.signIn?.state !== "waiting" ? (
        <div className={s.inline}>
          <button type="button" className={a.textLink} onClick={() => setPasting(true)}>
            Paste a key instead
          </button>
          {editing ? (
            <Button size="sm" variant="ghost" onClick={() => (setEditing(false), setProblem(null))}>
              Cancel
            </Button>
          ) : null}
        </div>
      ) : null}
      {open && pasting ? (
        <>
          <Field label="API key" description={cloud.hasKey ? "A new key replaces the saved one." : "From boat.dev › API keys, scoped as the setup step says."}>
            <Input mono aria-label="boat.dev API key" className={s.secretValue} data-secret="" value={key} disabled={busy !== null} autoComplete="off" spellCheck={false} placeholder="boat_…" onChange={(e) => setKey(e.target.value)} />
          </Field>
          <div className={s.inline}>
            <Button variant="primary" disabled={busy !== null || key.trim() === ""} onClick={() => void save()}>
              {busy === "save" ? "Saving…" : busy === "test" ? "Testing…" : "Save and test"}
            </Button>
            <Button variant="ghost" disabled={busy !== null} onClick={() => (setPasting(false), setKey(""), setProblem(null))}>
              Cancel
            </Button>
          </div>
        </>
      ) : null}
      {problem === null ? null : (
        <p role="alert">
          <Text size="sm" tone="danger">
            {problem}
          </Text>
        </p>
      )}
    </Setting>
  );
}

/** "Sign in with boat": the hub runs boat.dev's sign-in, so the person opens boat's page, signs in, then types the code
 * shown here (after the link, as boat asks: its own email sign-in sends a code too). The hub then makes and seals its
 * narrow key and revokes the sign-in's own; this view follows it from cloud_get until it ends. Its form shows while
 * the key is open to change (none yet, or Change) and no key is being pasted. */
function SignIn({ cloud, form, onDone }: { cloud: CloudView; form: boolean; onDone: () => void }) {
  const call = useHubCall();
  const keep = useKeep();
  const refetch = useRefetch();
  const signIn = cloud.signIn;
  const [email, setEmail] = useState(signIn?.email ?? "");
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const waiting = signIn?.state === "waiting";
  const state = signIn?.state;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => refetch(["cloud_get"]), 3_000);
    return () => clearInterval(timer);
  }, [waiting, refetch]);
  useEffect(() => {
    if (state === "done") {
      refetch(["setup_list", "doctor_list"]);
      onDone();
    }
    // onDone is the parent's fresh closure each render; only the state's change matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, refetch]);
  const start = async (to: string | undefined) => {
    setBusy(true);
    setProblem(null);
    setOpened(false);
    try {
      keep((await call("cloud_sign_in", to === undefined ? {} : { email: to }, { timeoutMs: 60_000 })).cloud);
    } catch (e) {
      setProblem(errorText(e));
    }
    setBusy(false);
  };
  if (waiting) {
    const uri = signIn.verificationUri ?? "";
    return (
      <div className={a.signIn} data-sign-in="waiting">
        <Text size="sm">{`1. Open boat.dev and sign in as ${signIn.email}, with GitHub, Google or email.`}</Text>
        <div className={s.inline}>
          <Button variant={opened ? "secondary" : "primary"} onClick={() => (setOpened(true), void window.fleetd.openExternal(uri))}>
            Open boat.dev
          </Button>
          {opened ? null : (
            <Button variant="ghost" onClick={() => setOpened(true)}>
              I&apos;m signed in
            </Button>
          )}
          <Button variant="ghost" disabled={busy} onClick={() => void start(undefined)}>
            Cancel
          </Button>
        </div>
        {opened ? (
          <>
            <Text size="sm">2. Once you are signed in, enter this code on boat.dev&apos;s page:</Text>
            <div className={a.signInCode} data-sign-in-code="">
              {signIn.userCode ?? ""}
            </div>
            <Text size="xs" tone="quiet">
              Waiting for boat.dev… Then the hub makes its own key, with only the actions it needs, and revokes the sign-in&apos;s.
            </Text>
          </>
        ) : null}
      </div>
    );
  }
  return (
    <>
      {signIn?.said === undefined ? null : (
        <Text size="sm" tone={signIn.state === "done" ? "success" : "danger"} data-sign-in={signIn.state}>
          <HubText>{signIn.said}</HubText>
        </Text>
      )}
      {!form ? null : (
        <>
          <Field label="Your boat.dev email" description="Sign in to your boat.dev account, and the hub makes its key there.">
            <Input aria-label="boat.dev email" type="email" value={email} disabled={busy} autoComplete="email" spellCheck={false} placeholder="you@example.com" onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <div className={s.inline}>
            <Button variant="primary" disabled={busy || !email.includes("@")} onClick={() => void start(email.trim())}>
              {busy ? "Starting…" : "Sign in with boat"}
            </Button>
          </div>
        </>
      )}
      {problem === null ? null : (
        <p role="alert">
          <Text size="sm" tone="danger">
            {problem}
          </Text>
        </p>
      )}
    </>
  );
}

/** How cloud machines reach the hub: through the SSH tunnel the hub holds to each, so nothing is set up on the network.
 * The Test of the whole way shows here, refreshed while it runs, with the public half of the hub's own SSH key. */
function WaySetting({ cloud }: { cloud: CloudView }) {
  const refetch = useRefetch();
  const test = cloud.pathTest;
  const running = test !== undefined && test.ok === undefined;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => refetch(["cloud_get"]), 5_000);
    return () => clearInterval(timer);
  }, [running, refetch]);
  const untested = !cloud.hasKey
    ? "Nothing to set up: a hub only your tailnet or LAN reaches works."
    : cloud.enabled
      ? "Not tested yet: Test wakes (or makes) a cloud machine and checks the hub's tunnel to it and its node's hello."
      : "Turn cloud machines on, then Test checks the whole way to the hub.";
  return (
    <Setting
      reveal="hub.cloud.way"
      label="Way to the hub"
      help="The hub dials each cloud machine it wakes and holds an SSH tunnel to it, which the machine's node reaches the hub through. The hub stays private: no public address, port or proxy to set up."
    >
      {test === undefined ? (
        <Text size="sm" tone="quiet" data-way="untested">
          {untested}
        </Text>
      ) : (
        <Text size="sm" tone={test.ok === true ? "success" : test.ok === false ? "danger" : "default"} data-way={test.ok === true ? "ok" : test.ok === false ? "failed" : "testing"}>
          <HubText>{test.said}</HubText>
        </Text>
      )}
      {cloud.sshKey === undefined ? null : (
        <Text size="sm" tone="quiet">
          {"The hub's own SSH key, which boat.dev puts on each cloud machine (its private half never leaves the hub): "}
          <Text size="sm" mono>
            {cloud.sshKey}
          </Text>
        </Text>
      )}
    </Setting>
  );
}

const POOL_SIZES = Array.from({ length: 10 }, (_, i) => String(i + 1));

/** The pool, the budgets, the projects and the switch, saved together; what it can cost is worked out as they change. */
function PoolSettings({ cloud }: { cloud: CloudView }) {
  const call = useHubCall();
  const keep = useKeep();
  const refetch = useRefetch();
  const projects = (useProjects() ?? []).filter((p) => p.kind !== "assistant");
  const [poolSize, setPoolSize] = useState(cloud.poolSize);
  const [machineType, setMachineType] = useState(cloud.machineType);
  const [day, setDay] = useState(cloud.dayBudget.toFixed(2));
  const [month, setMonth] = useState(cloud.monthIsPlan ? "" : cloud.monthBudget.toFixed(2));
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(cloud.projects.map((r) => `${r.machineId}/${r.projectId}`)));
  // The environment the setup step had them make, until one is saved: Create refuses without one.
  const [environment, setEnvironment] = useState(cloud.environment ?? cloud.environmentDefault);
  const [writers, setWriters] = useState(cloud.writers);
  const [busy, setBusy] = useState<"save" | "create" | "resume" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [lines, setLines] = useState<ReadonlyArray<string>>([]);
  const dayBudget = parseDollars(day);
  const monthBudget = month.trim() === "" ? undefined : parseDollars(month);
  const valid = dayBudget !== null && monthBudget !== null;
  const preview = costPreview(cloud, { poolSize, machineType, dayBudget: dayBudget ?? cloud.dayBudget, monthBudget: monthBudget ?? undefined });
  const refs = [...picked].map((k) => {
    const [machineId = "", projectId = ""] = k.split("/");
    return { machineId, projectId };
  });
  const save = async (enabled: boolean) => {
    if (dayBudget === null || monthBudget === null) return;
    setBusy("save");
    setProblem(null);
    try {
      const out = await call("cloud_set", {
        enabled,
        poolSize,
        machineType,
        dayBudget,
        ...(monthBudget === undefined ? {} : { monthBudget }),
        projects: refs,
        writers,
        ...(environment.trim() === "" ? {} : { environment: environment.trim() }),
      });
      keep(out.cloud);
      refetch(["setup_list", "doctor_list"]);
    } catch (e) {
      setProblem(errorText(e));
    }
    setBusy(null);
  };
  const create = async () => {
    setBusy("create");
    setProblem(null);
    try {
      const out = await call("cloud_create", {}, { timeoutMs: 100_000 });
      keep(out.cloud);
      setLines(out.lines);
      refetch(["setup_list", "doctor_list"]);
    } catch (e) {
      setProblem(errorText(e));
    }
    setBusy(null);
  };
  const resume = async () => {
    setBusy("resume");
    try {
      keep((await call("cloud_resume", {})).cloud);
    } catch (e) {
      setProblem(errorText(e));
    }
    setBusy(null);
  };
  const made = cloud.machines.filter((m) => m.state !== "failed" && m.state !== "gone").length;
  const missing = Math.max(0, cloud.poolSize - made);
  const changed =
    poolSize !== cloud.poolSize ||
    machineType !== cloud.machineType ||
    dayBudget !== cloud.dayBudget ||
    (monthBudget ?? null) !== (cloud.monthIsPlan ? null : cloud.monthBudget) ||
    environment.trim() !== (cloud.environment ?? "") ||
    writers !== cloud.writers ||
    refs.length !== cloud.projects.length ||
    refs.some((r) => !cloud.projects.some((p) => p.machineId === r.machineId && p.projectId === r.projectId));
  const toggle = (key: string, on: boolean) =>
    setPicked((was) => {
      const next = new Set(was);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  return (
    <>
      <Setting reveal="hub.cloud.pool" label="Pool" help="A fixed few machines, made once and kept asleep. Asleep they cost nothing; work wakes one, and it sleeps again 15 minutes after it is idle.">
        <div className={s.inline}>
          <Select aria-label="Machines" className={a.pick} value={String(poolSize)} options={POOL_SIZES.map((n) => ({ value: n, label: `${n} ${n === "1" ? "machine" : "machines"}` }))} disabled={busy !== null} onValueChange={(v) => setPoolSize(Number(v))} />
          <Select
            aria-label="Size"
            className={a.pick}
            value={machineType}
            options={cloud.sizes.map((z) => ({ value: z.kind, label: `${z.kind} · ${rate(z.perHour)}/h` }))}
            disabled={busy !== null}
            onValueChange={setMachineType}
          />
        </div>
        <Text size="xs" tone="quiet">
          large: 8 vCPUs, 16 GB. Grow by adding machines rather than a bigger size: xlarge costs more per vCPU and needs boat.dev&apos;s $100 plan.
        </Text>
      </Setting>
      <Setting reveal="hub.cloud.budgets" label="Budgets" help="In the hub's time zone. Past one, no machine wakes and awake ones stop within 30 minutes; your own machines go on.">
        <div className={s.inline}>
          <Field label="A day" error={dayBudget === null ? "Dollars above 0" : undefined}>
            <Input aria-label="Day budget" className={a.money} value={day} inputMode="decimal" disabled={busy !== null} onChange={(e) => setDay(e.target.value)} />
          </Field>
          <Field label="A month" error={monthBudget === null ? "Dollars above 0, or empty" : undefined}>
            <Input aria-label="Month budget" className={a.money} value={month} inputMode="decimal" placeholder={`plan's ${money(cloud.planDollars ?? 20)}`} disabled={busy !== null} onChange={(e) => setMonth(e.target.value)} />
          </Field>
        </div>
        <Text size="xs" tone="quiet">{`Today ${money(cloud.today)} of ${money(cloud.dayBudget)} · this month ${money(cloud.month)} of ${money(cloud.monthBudget)}`}</Text>
      </Setting>
      <Setting reveal="hub.cloud.projects" label="Projects" help="Only the projects you tick run on cloud machines: their code, transcripts and the secrets sealed there go to boat.dev. Their reviews and readers may go there; writers only once you allow them.">
        {projects.length === 0 ? (
          <Text size="sm" tone="quiet">
            No projects yet.
          </Text>
        ) : (
          <div className={a.checks}>
            {projects.map((p) => {
              const k = `${p.machineId}/${p.projectId}`;
              return <Checkbox key={k} label={p.title} checked={picked.has(k)} disabled={busy !== null} onCheckedChange={(on) => toggle(k, on === true)} />;
            })}
          </div>
        )}
        <Switch
          label="Writers too"
          description="Off: only reviews and readers go to cloud machines. On: a writer's follow-ups wake the machine it ran on."
          checked={writers}
          disabled={busy !== null}
          onCheckedChange={setWriters}
        />
      </Setting>
      <Setting reveal="hub.cloud.environment" label="boat.dev environment" help="The environment you made for fleetd, marked safe for third parties. The key is scoped to it.">
        <Input aria-label="boat.dev environment" mono className={a.environment} value={environment} placeholder={cloud.environmentDefault} disabled={busy !== null} onChange={(e) => setEnvironment(e.target.value)} />
      </Setting>
      <Setting reveal="hub.cloud.cost" label="What it can cost" help="Before you turn it on. Work goes to cloud only when every machine here is at its agent limit, so most days cost far less than the ceiling.">
        <dl className={a.cost} data-cost="">
          <dt>Price</dt>
          <dd>{preview.perHour}</dd>
          <dt>Ceiling</dt>
          <dd>
            {preview.ceiling}
            {preview.stops === null ? null : ` ${preview.stops}`}
          </dd>
          <dt>Typical day</dt>
          <dd>{preview.typical}</dd>
          <dt>Month</dt>
          <dd>{preview.month}</dd>
        </dl>
      </Setting>
      <Setting reveal="hub.cloud.on" label="Turn on" help="Work may go to cloud machines. Stop all cloud machines turns this off.">
        <Switch
          label={cloud.enabled ? "On: work may go to cloud machines" : "Off: no work goes to cloud machines"}
          checked={cloud.enabled}
          disabled={busy !== null || !valid || (!cloud.enabled && cloud.keyTest?.ok !== true)}
          description={!cloud.enabled && cloud.keyTest?.ok !== true ? "Test the key first." : undefined}
          onCheckedChange={(on) => void save(on)}
        />
        {heldLine(cloud) === null ? null : (
          <Text size="sm" tone="warning">
            <HubText>{heldLine(cloud) ?? ""}</HubText>
          </Text>
        )}
        <div className={s.inline}>
          <Button variant={changed ? "primary" : "secondary"} disabled={busy !== null || !valid || !changed} onClick={() => void save(cloud.enabled)}>
            {busy === "save" ? "Saving…" : "Save"}
          </Button>
          {cloud.enabled && missing > 0 && !changed ? (
            <Button variant="primary" disabled={busy !== null} onClick={() => void create()}>
              {busy === "create" ? "Creating…" : `Create ${missing === 1 ? "the cloud machine" : `${String(missing)} cloud machines`} (${String(missing)} ${missing === 1 ? "start" : "starts"})`}
            </Button>
          ) : null}
          {cloud.paused === undefined ? null : (
            <Button variant="ghost" disabled={busy !== null} onClick={() => void resume()}>
              {busy === "resume" ? "Resuming…" : "Resume"}
            </Button>
          )}
        </div>
        {lines.map((line) => (
          <Text key={line} size="xs" tone={line.includes("not created") ? "danger" : "quiet"} data-create-line="">
            {line}
          </Text>
        ))}
        {problem === null ? null : (
          <p role="alert">
            <Text size="sm" tone="danger">
              {problem}
            </Text>
          </p>
        )}
      </Setting>
    </>
  );
}
