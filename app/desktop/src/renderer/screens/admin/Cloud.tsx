// Cloud machines on boat.dev (D306), in Settings › Hub › Machines and the setup step: the boat.dev group beside the
// person's own machines (each machine's state, what runs there and its spend today, Reset for a broken one, and the
// kill switch), then the settings, in the same rows as the page's other settings: the hub's boat.dev key (sealed in main
// to the hub's own key, never shown again) with Test, the pool (how many machines; their size stays what the hub has,
// large unless the CLI set another), the budgets, the projects that may use it, the environment, what it can cost,
// shown before it is turned on, and the switch, with the Test of the whole way to the hub under it (the hub dials each
// machine and holds an SSH tunnel to it, so there is nothing to set up for it). The hub's pool
// (cloud_get) is the only source; a hub without it shows nothing here. The members' line is CloudStatus.tsx.
import { useEffect, useState } from "react";
import type { CloudView, ToolOutput } from "../../../shared/contracts";
import { callKey } from "../../src/data/queries";
import { useDataLayer, useHub } from "../../src/data/react";
import { Button, Checkbox, Dialog, Field, Input, Select, Text, toast } from "../../ui";
import { errorText, useHubCall, useRefetch } from "../settings/hub";
import { DangerButton, GroupNote, SettingsList, SettingsListRow, SettingsRow, SettingsSection, SwitchRow, useProjects } from "../settings/parts";
import { awakeCount, cloudStatusLine, costPreview, heldLine, machineLine, money, parseDollars, resettable, stateTone, stateWord, stopAllLine } from "./cloudModel";
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
    <SettingsSection
      title="boat.dev"
      data={{ "data-cloud-group": "" }}
      intro={status === null ? "Cloud machines" : `${status}${cloud.enabled ? "" : ": no work goes to them"}`}
      aside={
        cloud.enabled || awakeCount(cloud) > 0 ? (
          <DangerButton size="sm" onClick={() => setStopping(true)}>
            Stop all cloud machines
          </DangerButton>
        ) : undefined
      }
    >
      {held === null ? null : (
        <GroupNote tone="warning">
          <HubText>{held}</HubText>
        </GroupNote>
      )}
      <SettingsList label="Cloud machines">
        {cloud.machines.map((m) => (
          <SettingsListRow
            key={m.machineId}
            name={m.machineId}
            label={m.machineId}
            state={{ word: stateWord(m.state), tone: stateTone(m.state) }}
            data={{ "data-cloud-machine": m.machineId, "data-state": m.state }}
            controls={
              resettable(m.state) ? (
                <Button size="sm" variant="ghost" onClick={() => setReset(m.machineId)}>
                  Reset
                </Button>
              ) : undefined
            }
          >
            <Text size="sm" tone={m.state === "broken" || m.state === "failed" ? "default" : "quiet"}>
              {machineLine(m, nowMs)}
            </Text>
          </SettingsListRow>
        ))}
      </SettingsList>
      {stopping ? <StopAll cloud={cloud} onClose={() => setStopping(false)} /> : null}
      {reset === null ? null : <ResetDialog machineId={reset} onClose={() => setReset(null)} />}
    </SettingsSection>
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
            description: out.failed.length > 0 ? `Not stopped: ${out.failed.join("; ")}. They stop on their own within 30 minutes.` : "No work goes to them until you turn them on again.",
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
    <SettingsSection
      title="Cloud machines"
      reveal="hub.cloud"
      intro="When every machine here is at its agent limit, work runs on a few sleeping boat.dev machines of your own account, within budgets you set."
    >
      {cloud === undefined ? <GroupNote>Loading…</GroupNote> : <CloudSettings cloud={cloud} />}
    </SettingsSection>
  );
}

const DOCS = "https://fleetd.sh/docs/cloud-machines/";

/** The cloud machines' settings, rows of their section here and inline in the setup step. */
export function CloudSettings({ cloud }: { cloud: CloudView }) {
  return (
    <>
      <GroupNote>
        Cloud machines run on boat.dev: boat.dev can see what runs on them, as any host can.{" "}
        <button type="button" className={a.textLink} onClick={() => void window.fleetd.openExternal(DOCS)}>
          What it costs and what boat.dev sees
        </button>
      </GroupNote>
      <KeySetting cloud={cloud} />
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
    await test();
  };
  const open = editing || !cloud.hasKey;
  const tested = cloud.keyTest;
  return (
    <SettingsRow
      reveal="hub.cloud.key"
      title="boat.dev key"
      line={
        cloud.hasKey
          ? "Saved, sealed to the hub. fleetd never shows it again, and no machine or agent gets it."
          : "An API key of your own boat.dev account, with only the actions the setup step lists. It is sealed on this computer to the hub: fleetd never shows it again, and no machine or agent gets it."
      }
      control={
        cloud.hasKey ? (
          <>
            <Button size="sm" disabled={busy !== null} onClick={() => void test()}>
              {busy === "test" ? "Testing…" : "Test"}
            </Button>
            {editing ? null : (
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                Change
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      {cloud.hasKey && tested !== undefined ? (
        <Text size="sm" tone={tested.ok ? "success" : "danger"} data-key-test={tested.ok ? "ok" : "failed"}>
          <HubText>{tested.said}</HubText>
        </Text>
      ) : null}
      {open ? (
        <>
          <Field label="API key" description={cloud.hasKey ? "A new key replaces the saved one." : "From boat.dev › API keys, scoped as the setup step says."}>
            <Input mono aria-label="boat.dev API key" className={s.secretValue} data-secret="" value={key} disabled={busy !== null} autoComplete="off" spellCheck={false} placeholder="boat_…" onChange={(e) => setKey(e.target.value)} />
          </Field>
          <div className={s.inline}>
            <Button variant="primary" disabled={busy !== null || key.trim() === ""} onClick={() => void save()}>
              {busy === "save" ? "Saving…" : busy === "test" ? "Testing…" : "Save and test"}
            </Button>
            {editing ? (
              <Button variant="ghost" disabled={busy !== null} onClick={() => (setEditing(false), setKey(""), setProblem(null))}>
                Cancel
              </Button>
            ) : null}
            {busy === null && key.trim() === "" ? (
              <Text size="sm" tone="quiet">
                Paste a key to save it.
              </Text>
            ) : null}
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
    </SettingsRow>
  );
}

/** The Test of the whole way to the hub (the hub's tunnel to a cloud machine and its node's hello), once there is one,
 * refreshed while it runs. */
function PathTest({ cloud }: { cloud: CloudView }) {
  const refetch = useRefetch();
  const test = cloud.pathTest;
  const running = test !== undefined && test.ok === undefined;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => refetch(["cloud_get"]), 5_000);
    return () => clearInterval(timer);
  }, [running, refetch]);
  if (test === undefined) return null;
  return (
    <GroupNote tone={test.ok === true ? "success" : test.ok === false ? "danger" : "default"}>
      <span data-way={test.ok === true ? "ok" : test.ok === false ? "failed" : "testing"}>
        <HubText>{test.said}</HubText>
      </span>
    </GroupNote>
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
  const [day, setDay] = useState(cloud.dayBudget.toFixed(2));
  const [month, setMonth] = useState(cloud.monthIsPlan ? "" : cloud.monthBudget.toFixed(2));
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(cloud.projects.map((r) => `${r.machineId}/${r.projectId}`)));
  // The environment the setup step had them make, until one is saved: Create refuses without one.
  const [environment, setEnvironment] = useState(cloud.environment ?? cloud.environmentDefault);
  const [busy, setBusy] = useState<"save" | "create" | "resume" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [lines, setLines] = useState<ReadonlyArray<string>>([]);
  const dayBudget = parseDollars(day);
  const monthBudget = month.trim() === "" ? undefined : parseDollars(month);
  const valid = dayBudget !== null && monthBudget !== null;
  const preview = costPreview(cloud, { poolSize, machineType: cloud.machineType, dayBudget: dayBudget ?? cloud.dayBudget, monthBudget: monthBudget ?? undefined });
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
        machineType: cloud.machineType,
        dayBudget,
        ...(monthBudget === undefined ? {} : { monthBudget }),
        projects: refs,
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
    dayBudget !== cloud.dayBudget ||
    (monthBudget ?? null) !== (cloud.monthIsPlan ? null : cloud.monthBudget) ||
    environment.trim() !== (cloud.environment ?? "") ||
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
      <SettingsRow
        reveal="hub.cloud.pool"
        title="Pool"
        line="Free while asleep. Work wakes one; it sleeps after 15 idle minutes."
        control={
          <Select aria-label="Machines" className={a.pick} value={String(poolSize)} options={POOL_SIZES.map((n) => ({ value: n, label: `${n} ${n === "1" ? "machine" : "machines"}` }))} disabled={busy !== null} onValueChange={(v) => setPoolSize(Number(v))} />
        }
      />
      <SettingsRow reveal="hub.cloud.budgets" title="Budgets" line="Past a budget, cloud machines stop within 30 minutes. Your own machines go on.">
        <div className={s.inline}>
          <Field label="A day" error={dayBudget === null ? "Dollars above 0" : undefined}>
            <Input aria-label="Day budget" className={a.money} value={day} inputMode="decimal" disabled={busy !== null} onChange={(e) => setDay(e.target.value)} />
          </Field>
          <Field label="A month" error={monthBudget === null ? "Dollars above 0, or empty" : undefined}>
            <Input aria-label="Month budget" className={a.money} value={month} inputMode="decimal" placeholder={`plan's ${money(cloud.planDollars ?? 20)}`} disabled={busy !== null} onChange={(e) => setMonth(e.target.value)} />
          </Field>
        </div>
        <Text size="sm" tone="quiet">{`Today ${money(cloud.today)} of ${money(cloud.dayBudget)} · this month ${money(cloud.month)} of ${money(cloud.monthBudget)}`}</Text>
      </SettingsRow>
      <SettingsRow
        reveal="hub.cloud.projects"
        title="Projects"
        line="Only the projects you tick run on cloud machines: their code, transcripts and the secrets sealed there go to boat.dev. Any of their agents may go there, and a writer's follow-ups wake the machine it ran on."
      >
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
      </SettingsRow>
      <SettingsRow
        reveal="hub.cloud.environment"
        title="boat.dev environment"
        line="The environment you made for fleetd, marked safe for third parties. The key is scoped to it."
        control={<Input aria-label="boat.dev environment" mono className={a.environment} value={environment} placeholder={cloud.environmentDefault} disabled={busy !== null} onChange={(e) => setEnvironment(e.target.value)} />}
      />
      <SettingsRow reveal="hub.cloud.cost" title="What it can cost" line="Most days cost far less than the ceiling.">
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
      </SettingsRow>
      <SwitchRow
        reveal="hub.cloud.on"
        title="Use cloud machines"
        checked={cloud.enabled}
        disabled={busy !== null || !valid || (!cloud.enabled && cloud.keyTest?.ok !== true)}
        line={!cloud.enabled && cloud.keyTest?.ok !== true ? "Test the key first." : !valid ? "Fix the budgets first." : undefined}
        onCheckedChange={(on) => void save(on)}
      />
      {/* A pause says why on its own row, with Resume. */}
      {heldLine(cloud) === null || cloud.paused !== undefined ? null : (
        <GroupNote tone="warning">
          <HubText>{heldLine(cloud) ?? ""}</HubText>
        </GroupNote>
      )}
      <PathTest cloud={cloud} />
      {changed ? (
        <SettingsRow
          title="Save the changes"
          line={valid ? "The pool, budgets, projects and environment are saved together." : "Fix the budgets first."}
          control={
            <Button size="sm" variant="primary" disabled={busy !== null || !valid} onClick={() => void save(cloud.enabled)}>
              {busy === "save" ? "Saving…" : "Save"}
            </Button>
          }
        />
      ) : null}
      {cloud.enabled && missing > 0 && !changed ? (
        <SettingsRow
          title={missing === 1 ? "One cloud machine isn't made yet" : `${String(missing)} cloud machines aren't made yet`}
          line={`Making ${missing === 1 ? "it" : "them"} spends ${String(missing)} ${missing === 1 ? "start" : "starts"}.`}
          control={
            <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => void create()}>
              {busy === "create" ? "Creating…" : `Create ${missing === 1 ? "the cloud machine" : `${String(missing)} cloud machines`} (${String(missing)} ${missing === 1 ? "start" : "starts"})`}
            </Button>
          }
        />
      ) : null}
      {cloud.paused === undefined ? null : (
        <SettingsRow
          title="Paused"
          line={<HubText>{heldLine(cloud) ?? ""}</HubText>}
          lineTone="warning"
          control={
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void resume()}>
              {busy === "resume" ? "Resuming…" : "Resume"}
            </Button>
          }
        />
      )}
      {lines.map((line) => (
        <GroupNote key={line} tone={line.includes("not created") ? "danger" : "quiet"}>
          <span data-create-line="">{line}</span>
        </GroupNote>
      ))}
      {problem === null ? null : (
        <GroupNote tone="danger">
          <span role="alert">{problem}</span>
        </GroupNote>
      )}
    </>
  );
}
