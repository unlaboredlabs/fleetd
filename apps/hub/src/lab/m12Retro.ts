// M12 lab check, standalone (no T3 or nodes needed): `node apps/hub/src/lab/m12Retro.ts` after `pnpm --filter
// fleetd build`. Seeds a synthetic incident history into a fresh hub home under the
// lab, starts the built hub with the user's own claude login, and runs `fleetd retro run --advise`: one real
// claude-haiku-5-5 turn. Checks the run is recorded as orchestrator usage, every kept proposal is only suggested,
// no playbook file was written, and the digest and MCP tools show it. The hub is stopped by its spawn PID.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { IncidentClass, MachineId, ProjectId } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Incidents from "../incidents/Incidents.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubDb from "../store/HubDb.ts";
import { type Body, callToolWith, check, CLI, cli, LAB, log, ok, scrubbedEnv, startCli, stopAll, until } from "./harness.ts";

const PORT = Number(process.env.FLEETD_LAB_M12_PORT ?? 4797);
const URL_ = `http://127.0.0.1:${PORT}`;
const HOME = path.join(LAB, `m12-retro-${PORT}`);
const REF = { machineId: "lab-a" as MachineId, projectId: "p-demo" as ProjectId };

/** Three false claims, two estimate misses and a polish loop on bugfix-style work over the last week. */
const HISTORY: ReadonlyArray<{ readonly class: IncidentClass; readonly evidence: ReadonlyArray<string> }> = [
  { class: "false_claim", evidence: ["C3 on W4: the lead claimed done; check 0 (cmd: pnpm test) failed with exit 1", "The repro was never run before the claim."] },
  { class: "false_claim", evidence: ["C5 on W6: the lead claimed done; check 0 (test: repro-login) failed", "The task said 'fixed' with 0 commands run."] },
  { class: "false_claim", evidence: ["C8 on W9: the lead claimed done; check 1 (http GET /healthz) returned 500"] },
  { class: "estimate_miss", evidence: ["W4 (tier S) took 95 min against a raw estimate of 20 min: 4.8x, over the 2x limit."] },
  { class: "estimate_miss", evidence: ["W9 (tier S) took 70 min against a raw estimate of 15 min: 4.7x, over the 2x limit."] },
  { class: "polish_loop", evidence: ["Change C2 had 3 review rounds with zero blocking findings after the first."] },
];

const seed = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const incidents = yield* Incidents.Incidents;
        for (const item of HISTORY) yield* incidents.record({ class: item.class, projectRef: REF, evidence: item.evidence });
      }).pipe(Effect.provide(Incidents.layer.pipe(Layer.provideMerge(EventLog.layer), Layer.provideMerge(HubDb.layer(HOME))))),
    ),
  );

async function main() {
  check(fs.existsSync(CLI), `the built CLI at ${CLI} (run pnpm --filter fleetd build first)`);
  fs.rmSync(HOME, { recursive: true, force: true });
  await seed();
  ok(`seeded ${HISTORY.length} incidents into ${HOME}`);
  const key = /fld_[a-z2-7]{20,}/u.exec(cli("hub", "key", "create", "--home", HOME, "--name", "lab-admin", "--role", "admin", "--machines", "*"))?.[0];
  check(key, "hub key create printed a key");
  const keyFile = path.join(HOME, "admin.key");
  fs.writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });

  startCli("hub-m12", ["hub", "start", "--home", HOME, "--listen", `127.0.0.1:${PORT}`]);
  await until("hub /healthz", 30_000, async () => {
    try {
      return (await fetch(`${URL_}/healthz`)).ok ? true : undefined;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
      return undefined;
    }
  });
  ok(`hub up on ${URL_}`);

  // The one real turn.
  const started = Date.now();
  const out = execFileSync(process.execPath, [CLI, "retro", "run", "--hub", URL_, "--key-file", keyFile, "--advise", "--window", "14d"], {
    env: scrubbedEnv(),
    encoding: "utf8",
  });
  log(`fleetd retro run (${((Date.now() - started) / 1000).toFixed(1)} s):\n${out.trimEnd()}`);
  check(/^retro run 1 \(manual, advise-only\): 6 incidents in 14 d/mu.test(out), "the run saw the 6 seeded incidents, advise-only");
  check(/^usage: claude-haiku-5-5, /mu.test(out), "the turn ran on claude-haiku-5-5");

  const client = new Client({ name: "fleetd-m12-lab", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${URL_}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }) as Transport);
  const callTool = callToolWith(() => client);
  try {
    const listed = (await callTool("retro_proposals")).body;
    check(listed.apply === false, "policy.retro.apply is off");
    check(listed.lastRun?.usage?.kind === "orchestrator", `the run is orchestrator usage: ${JSON.stringify(listed.lastRun?.usage)}`);
    check((listed.proposals as Array<Body>).every((p) => p.state === "suggested"), "every proposal is only suggested");
    ok(`retro_proposals: ${listed.proposals.length} suggested, ${listed.lastRun.dropped.length} dropped, usage ${JSON.stringify(listed.lastRun.usage)}`);
    for (const p of listed.proposals as Array<Body>) log(`  ${p.proposalId} ${p.playbook} ${p.kind} (${p.fields.join(", ")}) fixes ${p.fixesIncidents.join(", ")}: ${p.expected}`);
    for (const d of listed.lastRun.dropped as Array<Body>) log(`  dropped #${d.index + 1}: ${d.reason}`);

    const ran = (await callTool("events_wait", { cursor: 0, types: ["retro.ran"], timeoutSec: 1 })).body.events as Array<Body>;
    check(ran.length === 1 && ran[0]!.data.usage?.[0]?.kind === "orchestrator", `one retro.ran event with its usage: ${JSON.stringify(ran)}`);
    check(!fs.existsSync(path.join(HOME, "playbooks")) || fs.readdirSync(path.join(HOME, "playbooks")).length === 0, "no playbook override was written");
    const counts = (await callTool("incidents_list", { windowDays: 14 })).body.counts as Array<Body>;
    check(counts[0]?.class === "false_claim" && counts[0]?.count === 3, `incidents_list counts: ${JSON.stringify(counts)}`);
    const digest = (await callTool("digest_get")).body.text as string;
    if (listed.proposals.length > 0) check(digest.includes("Suggested R1:"), `the digest shows the suggestions:\n${digest}`);
    ok(`digest:\n${digest}`);
  } finally {
    await client.close().catch(() => undefined);
  }
}

main()
  .then(() => log("PASS m12 retro"))
  .catch((error: unknown) => {
    log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => stopAll());
