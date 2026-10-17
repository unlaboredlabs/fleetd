import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { MachineId } from "@fleetd/contracts";
import { parseListen } from "@fleetd/hub/main.ts";
import * as HubDb from "@fleetd/hub/store/HubDb.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import pkg from "../../package.json" with { type: "json" };
import { enrollToken, forgetMachine, hasNodeKey, machineStatus, openHub, probeListen, waitOnline } from "./hubAccess.ts";
import {
  DEFAULT_T3_PORT,
  type Facts,
  freshFacts,
  type MachineAddInput,
  planMachineAdd,
  planMachineRemove,
  probeCommand,
  PROBE_SCRIPT,
  type Step,
  T3_NPM_VERSION,
} from "./machinePlan.ts";
import { directoryDigest, runSsh, showSsh, type SshTarget } from "./ssh.ts";
import { readSetup, writeSetup } from "./state.ts";
import { unitSuffix } from "./units.ts";

export const MACHINE_USAGE = `  machine add <ssh-host> [--machine-id <id>] [--tags a,b] [--dry-run] [--t3-port <port>]
            [--hub-url <url>] [--ssh-config <file>] [--home <hub home>] [--unit-suffix <s>]
             set up a worker over SSH: installs T3 ${T3_NPM_VERSION} and the fleetd node under the SSH
             user, configures the fleetd Claude instance, enrolls the node, starts both as services and
             waits until the machine is online; prints every remote command first, --dry-run only prints
             (for a fresh machine, without connecting); safe to run again
  machine remove <id> [--purge-t3] [--home <hub home>]
             stop and delete the node's service and key on the machine and revoke it on the hub; T3 and
             its data stay unless --purge-t3
`;

const say = (line = "") => process.stderr.write(`${line}\n`);
const fail = (message: string) => {
  say(`fleetd: ${message}`);
  return 1;
};
const usage = (message: string) => {
  say(`fleetd: ${message}\n\nusage:\n${MACHINE_USAGE}`);
  return 2;
};

/** `user@host.example:22` → `host`, as a machine id. */
export const machineIdFromHost = (host: string) =>
  (host.split("@").pop() ?? host).split(".")[0]!.toLowerCase().replace(/[^a-z0-9-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 32);

const hubHome = (home: string | undefined) => Effect.runSync(Effect.result(HubDb.resolveHubHome(home)));

const describeStdin = (step: Step, bundleDir: string) =>
  step.stdin === undefined
    ? undefined
    : step.stdin.kind === "bundle"
      ? `stdin: tar of ${bundleDir}`
      : step.stdin.kind === "enrollToken"
        ? "stdin: one-time enroll token (not shown)"
        : `stdin: ${step.stdin.label} (${Buffer.byteLength(step.stdin.text)} bytes)`;

const printStep = (index: number, total: number, step: Step, bundleDir: string) => {
  say(`[${index}/${total}] ${step.title}`);
  say(`  $ ${step.command}`);
  const stdin = describeStdin(step, bundleDir);
  if (stdin !== undefined) say(`    (${stdin})`);
};

const tail = (text: string) => text.trim().split("\n").slice(-15).join("\n");

const addCommand = async (argv: ReadonlyArray<string>): Promise<number> => {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        "machine-id": { type: "string" },
        tags: { type: "string" },
        "dry-run": { type: "boolean" },
        "t3-port": { type: "string" },
        "hub-url": { type: "string" },
        "ssh-config": { type: "string" },
        home: { type: "string" },
        "unit-suffix": { type: "string" },
      },
    });
  } catch (error) {
    return usage(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  const [host] = positionals;
  if (host === undefined || positionals.length > 1) return usage("machine add takes one ssh host");
  const machineId = values["machine-id"] ?? machineIdFromHost(host);
  if (!Schema.is(MachineId)(machineId)) return usage(`'${machineId}' is not a machine id ([a-z0-9-]{1,32}); pass --machine-id`);
  const t3Port = Number(values["t3-port"] ?? DEFAULT_T3_PORT);
  if (!Number.isInteger(t3Port) || t3Port < 1 || t3Port > 65535) return usage(`--t3-port must be a port, got '${values["t3-port"]}'`);

  const home = hubHome(values.home);
  if (home._tag === "Failure") return fail(home.failure.message);
  const state = readSetup(home.success);
  if (state === undefined) return fail(`${home.success} has no hub set up: run fleetd init first`);
  const suffix = values["unit-suffix"] === undefined ? state.unitSuffix : unitSuffix(values["unit-suffix"]);
  if (suffix === undefined) return usage(`--unit-suffix takes letters, digits and dashes, got '${values["unit-suffix"]}'`);
  const bundleDir = path.dirname(fs.realpathSync(process.argv[1] ?? ""));
  if (!fs.existsSync(path.join(bundleDir, "bin.js"))) {
    return fail(`machine add copies the built fleetd CLI to the machine, and ${bundleDir} has no bin.js: run it from a build (pnpm build, then node apps/cli/dist/bin.js)`);
  }
  const target: SshTarget = { host, ...(values["ssh-config"] === undefined ? {} : { config: path.resolve(values["ssh-config"]) }) };
  const input: Omit<MachineAddInput, "hubHasNodeKey"> = {
    machineId,
    tags: (values.tags ?? "").split(",").map((tag) => tag.trim()).filter(Boolean),
    hubUrl: values["hub-url"] ?? state.url,
    unitSuffix: suffix,
    t3Port,
    t3Version: T3_NPM_VERSION,
    gitIdentity: state.gitIdentity,
    bundleDigest: directoryDigest(bundleDir),
    cliVersion: pkg.version,
  };

  if (values["dry-run"] === true) {
    const user = host.includes("@") ? host.split("@")[0]! : os.userInfo().username;
    const plan = planMachineAdd(freshFacts(user), { ...input, hubHasNodeKey: false });
    if ("error" in plan) return fail(plan.error);
    say(`dry run: nothing runs. Planned for a fresh Linux machine at ${host} (home ${plan.layout.fleetd.replace(/\/\.fleetd$/u, "")}); a real run first reads the machine's state over SSH and leaves out what is already done:`);
    say(`[probe] read the machine's state (read-only)\n  $ ${probeCommand(input.unitSuffix)}\n    (stdin: the probe script)`);
    plan.steps.forEach((step, i) => printStep(i + 1, plan.steps.length, step, bundleDir));
    say(`[hub] wait until ${machineId} is online`);
    for (const note of plan.notes) say(`note: ${note}`);
    return 0;
  }

  const listen = parseListen(state.listen);
  if (listen === undefined || (await probeListen(listen)) !== "hub") {
    return fail(`no hub answers at ${state.listen}: start it first (fleetd init, or fleetd hub start --home ${home.success})`);
  }

  const hub = openHub(home.success);
  try {
    say(`setting up ${machineId} on ${host}; every remote command is shown before it runs.`);
    say(`[probe] read the machine's state (read-only)\n  $ ${probeCommand(input.unitSuffix)}\n    (stdin: the probe script)`);
    const probed = await runSsh(target, probeCommand(input.unitSuffix), PROBE_SCRIPT);
    if (probed.code !== 0) return fail(`cannot read ${host} over SSH (exit ${probed.code}):\n${tail(probed.stderr)}`);
    const facts = JSON.parse(probed.stdout.trim().split("\n").pop() ?? "{}") as Facts | { readonly error: string };
    if ("error" in facts) return fail(`no Node on ${host}: install Node 24 or newer for ${host.split("@")[0]}, then run again`);

    const plan = planMachineAdd(facts, { ...input, hubHasNodeKey: await hub.runPromise(hasNodeKey(machineId)) });
    if ("error" in plan) return fail(plan.error);
    // Recorded before anything changes, so `machine remove` can undo a run that stopped half way.
    writeSetup(home.success, {
      ...state,
      machines: {
        ...state.machines,
        [machineId]: {
          sshHost: host,
          ...(target.config === undefined ? {} : { sshConfig: target.config }),
          platform: plan.platform,
          home: facts.home,
          configHome: facts.configHome,
          uid: facts.uid,
          unitSuffix: input.unitSuffix,
          t3Port,
        },
      },
    });

    // Set after each step, so after the last one (the node's (re)start) only the new node can count as online.
    let stepsDone = Date.now();
    for (const [i, step] of plan.steps.entries()) {
      printStep(i + 1, plan.steps.length, step, bundleDir);
      const stdin =
        step.stdin === undefined
          ? undefined
          : step.stdin.kind === "text"
            ? step.stdin.text
            : step.stdin.kind === "bundle"
              ? execFileSync("tar", ["-C", bundleDir, "-cf", "-", "."], { maxBuffer: 1 << 30 })
              : `${(await hub.runPromise(enrollToken(machineId))).token}\n`;
      const result = await runSsh(target, step.command, stdin);
      if (result.code !== 0) return fail(`step ${i + 1} failed (exit ${result.code}):\n${tail(`${result.stdout}\n${result.stderr}`)}\nfix that and run the same command again; finished steps are skipped.`);
      stepsDone = Date.now();
      const shown = result.stdout.trim();
      if (shown.length > 0 && shown.length < 200 && !shown.includes("\n")) say(`  → ${shown}`);
    }

    const already = !plan.nodeRestarts && (await hub.runPromise(machineStatus(machineId))) === "online";
    if (!already) {
      say(`[hub] waiting until ${machineId} is online (up to 2 min)`);
      if (!(await hub.runPromise(waitOnline(machineId, stepsDone, 120_000)))) {
        return fail(`${machineId} did not come online within 2 min. Its node log is ${plan.layout.logs}/node.log on ${host}; the node must reach the hub at ${input.hubUrl}.`);
      }
    }
    say(`${machineId} is online.`);
    for (const note of plan.notes) say(`note: ${note}`);
    return 0;
  } finally {
    await hub.dispose();
  }
};

const removeCommand = async (argv: ReadonlyArray<string>): Promise<number> => {
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], allowPositionals: true, options: { "purge-t3": { type: "boolean" }, home: { type: "string" } } });
  } catch (error) {
    return usage(error instanceof Error ? error.message : String(error));
  }
  const [machineId] = parsed.positionals;
  if (machineId === undefined || !Schema.is(MachineId)(machineId)) return usage("machine remove takes a machine id");
  const home = hubHome(parsed.values.home);
  if (home._tag === "Failure") return fail(home.failure.message);
  const state = readSetup(home.success);
  const record = state?.machines[machineId];

  let remoteOk = true;
  if (record === undefined) {
    say(`${machineId} was not set up by fleetd machine add from this hub, so only its key is revoked here; stop its node by hand.`);
  } else {
    const target: SshTarget = { host: record.sshHost, ...(record.sshConfig === undefined ? {} : { config: record.sshConfig }) };
    const steps = planMachineRemove(record, parsed.values["purge-t3"] === true);
    for (const [i, step] of steps.entries()) {
      say(`[${i + 1}/${steps.length}] ${step.title}\n  $ ${step.command}`);
      const result = await runSsh(target, step.command);
      if (result.code !== 0) {
        remoteOk = false;
        say(`  failed (exit ${result.code}): ${tail(result.stderr)}`);
        say(`  run the remaining steps yourself:\n${steps.slice(i).map((s) => `    ${showSsh(target, s.command)}`).join("\n")}`);
        break;
      }
    }
  }

  const hub = openHub(home.success);
  try {
    const revoked = await hub.runPromise(forgetMachine(machineId));
    say(revoked ? `revoked ${machineId}'s node key; the hub refuses that node from now on.` : `the hub held no node key for ${machineId}.`);
  } finally {
    await hub.dispose();
  }
  if (state !== undefined && record !== undefined) {
    const { [machineId]: _removed, ...machines } = state.machines;
    writeSetup(home.success, { ...state, machines });
  }
  if (record !== undefined && parsed.values["purge-t3"] !== true) say(`T3 and its data stay on ${record.sshHost}; remove them with --purge-t3.`);
  return remoteOk ? 0 : 1;
};

/** `fleetd machine …`. */
export const machineCommand = (argv: ReadonlyArray<string>): Promise<number> => {
  const [command, ...rest] = argv;
  if (command === "add") return addCommand(rest);
  if (command === "remove") return removeCommand(rest);
  return Promise.resolve(usage(command ? `unknown machine command '${command}'` : "missing machine command"));
};
