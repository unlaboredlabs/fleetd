// `fleetd retro run`: asks the hub to run the retro now, over its MCP endpoint (retro_run, admin on every machine),
// and prints what it proposed and dropped.
import fs from "node:fs";
import { parseArgs } from "node:util";
import type { RetroProposal, RetroRun } from "@fleetd/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import pkg from "../package.json" with { type: "json" };

export const RETRO_USAGE = `  retro run --hub <url> --key-file <path> [--window 14d] [--advise]
             run the retro now: one claude -p turn over the window's incidents
             (1-28 days) proposes playbook changes; --advise only suggests them
`;

export type RetroArgs = { readonly hub: string; readonly keyFile: string; readonly windowDays: number; readonly advise: boolean } | { readonly error: string };

export const parseRetroArgs = (argv: ReadonlyArray<string>): RetroArgs => {
  const [command, ...rest] = argv;
  if (command !== "run") return { error: command === undefined ? "missing retro command" : `unknown retro command '${command}'` };
  let values;
  try {
    ({ values } = parseArgs({ args: [...rest], options: { hub: { type: "string" }, "key-file": { type: "string" }, window: { type: "string" }, advise: { type: "boolean" } } }));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (!values.hub) return { error: "--hub is required" };
  if (!values["key-file"]) return { error: "--key-file is required" };
  const window = /^([1-9]\d?)d?$/u.exec(values.window ?? "14d");
  const windowDays = window === null ? Number.NaN : Number(window[1]);
  if (!(windowDays >= 1 && windowDays <= 28)) return { error: `--window must be 1d to 28d, got '${values.window}'` };
  return { hub: values.hub, keyFile: values["key-file"], windowDays, advise: values.advise === true };
};

const line = (p: RetroProposal) =>
  `  ${p.proposalId} ${p.playbook} ${p.kind} (${p.fields.join(", ")}): ${p.state} · fixes ${p.fixesIncidents.join(", ")} · ${p.metric.class} down over ${p.metric.windowDays} d${p.note === undefined ? "" : ` · ${p.note}`}`;

/** What `retro run` prints. */
export const renderRun = (run: RetroRun, proposals: ReadonlyArray<RetroProposal>, next?: string) => {
  const head = `retro run ${run.run} (${run.trigger}${run.advise ? ", advise-only" : ""}): ${run.incidents} incident${run.incidents === 1 ? "" : "s"} in ${run.windowDays} d, ${proposals.length} proposed, ${run.dropped.length} dropped`;
  const usage = run.usage;
  return [
    head,
    ...proposals.map(line),
    ...run.dropped.map((d) => `  dropped #${d.index + 1}${d.playbook === undefined ? "" : ` ${d.playbook}`}: ${d.reason}`),
    ...(usage === undefined
      ? []
      : [`usage: ${usage.model}, ${(usage.durationMs / 1000).toFixed(1)} s${usage.inputTokens === undefined ? "" : `, ${usage.inputTokens} in / ${usage.outputTokens ?? 0} out tokens`}${usage.ok ? "" : ` (no usable answer: ${usage.error ?? "unknown"})`}`]),
    ...(next === undefined ? [] : [next]),
  ].join("\n");
};

/** `fleetd retro …`: exit 0 when the run happened, 1 when the hub refused it, 2 on bad flags. */
export const retroCommand = async (argv: ReadonlyArray<string>): Promise<number> => {
  const args = parseRetroArgs(argv);
  if ("error" in args) {
    process.stderr.write(`fleetd: ${args.error}\n\nusage:\n${RETRO_USAGE}`);
    return 2;
  }
  let key: string;
  try {
    key = fs.readFileSync(args.keyFile, "utf8").trim();
  } catch (error) {
    process.stderr.write(`fleetd retro: cannot read --key-file: ${(error as Error).message}\n`);
    return 2;
  }
  const client = new Client({ name: "fleetd-retro", version: pkg.version });
  const transport = new StreamableHTTPClientTransport(new URL("mcp", args.hub.endsWith("/") ? args.hub : `${args.hub}/`), {
    requestInit: { headers: { authorization: `Bearer ${key}` } },
  });
  try {
    await client.connect(transport as Transport);
    // A run is one claude turn, which can take a few minutes.
    const result = await client.callTool({ name: "retro_run", arguments: { windowDays: args.windowDays, ...(args.advise ? { advise: true } : {}) } }, undefined, { timeout: 290_000 });
    const body = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as { run: RetroRun; proposals: Array<RetroProposal>; next?: string; message?: string; fix?: string };
    if (result.isError === true) {
      process.stderr.write(`fleetd retro: ${body.message}${body.fix === undefined ? "" : `\n  fix: ${body.fix}`}\n`);
      return 1;
    }
    process.stdout.write(`${renderRun(body.run, body.proposals, body.next)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`fleetd retro: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    await client.close().catch(() => undefined);
  }
};
