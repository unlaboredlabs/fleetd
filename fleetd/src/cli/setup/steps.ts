// The hub's setup steps in the terminal: `fleetd init` and `fleetd doctor` list
// them (setup_list), one line each; `fleetd init --step <id>` opens one as a guide.
import type { McpClient } from "../mcp_client.ts";
import type { Failure } from "../common.ts";
import type { Checklist, State } from "./checklist.ts";

async function callFor(client: McpClient, tool: string, input: unknown, waitMs: number): Promise<any> {
  let result;
  try {
    result = await client.callTool(tool, input, waitMs);
  } catch (error) {
    const m = (error as Error).message;
    throw {
      message: `${tool} failed: ${m}`,
      fix: m.includes("not found")
        ? "fleetd update, so the hub has setup steps"
        : "fleetd doctor shows whether the hub is up; then run fleetd init again",
    } satisfies Failure;
  }
  if (result.isError) {
    const text = (k: string) => (typeof result.body?.[k] === "string" ? (result.body[k] as string) : undefined);
    throw { message: text("message") ?? JSON.stringify(result.body), fix: text("fix") ?? "fleetd init again" } satisfies Failure;
  }
  return result.body;
}

export const isFailure = (e: unknown): e is Failure =>
  typeof e === "object" && e !== null && "message" in e && "fix" in e && !(e instanceof Error);

/** The hub's steps; undefined from a hub too old to have them. Throws a Failure. */
export async function list(client: McpClient): Promise<any[] | undefined> {
  try {
    const body = await callFor(client, "setup_list", {}, 120_000);
    return Array.isArray(body?.steps) ? body.steps : [];
  } catch (f) {
    if (isFailure(f) && f.message.includes("not found")) return undefined;
    throw f;
  }
}

/** Runs one step's checks now: 1Password's Test as long as its first can take. */
export async function test(client: McpClient, id: string): Promise<any> {
  const body = await callFor(client, "setup_test", { step: id }, id === "onepassword" ? 300_000 : 120_000);
  return body?.step;
}

export function needWords(need: any): string {
  return need?.kind === "before" ? `before ${need.what}` : String(need?.kind);
}

const resume = (step: any) => step.fix?.command ?? `fleetd init --step ${step.id}`;

export function line(step: any): [State, string, string | undefined] {
  const said = String(step.said ?? "").replace(/\.+$/, "");
  switch (step.status) {
    case "done":
      return ["done", step.way ? `with ${step.way}: ${said}` : said, undefined];
    case "look":
      return [step.failing === true ? "failed" : "warn", said, resume(step)];
    default:
      if (step.need?.kind === "required") {
        const detail = said === "" ? String(step.why).replace(/\.+$/, "") : said;
        return ["failed", `required: ${detail}`, resume(step)];
      }
      return ["skipped", `${needWords(step.need)} · fleetd init --step ${step.id}`, undefined];
  }
}

export function show(list: Checklist, steps: any[]) {
  for (const step of steps) {
    const [state, detail, fix] = line(step);
    list.finish(step.title, state, detail, fix);
  }
}

export function matchesCheck(pattern: string, id: string): boolean {
  if (pattern.startsWith("*/")) {
    const name = pattern.slice(2);
    const slash = id.indexOf("/");
    return !id.startsWith("hub/") && slash >= 0 && id.slice(slash + 1) === name;
  }
  return pattern === id;
}

/** The doctor's checks no step owns. */
export function unowned(checks: any[], steps: any[]): any[] {
  const patterns = steps.flatMap((s) => (s.ways ?? []).flatMap((w: any) => w.checks ?? []));
  return checks.filter((c) => !patterns.some((p: string) => matchesCheck(p, c.id)));
}

function placeWords(place: string): string {
  if (place === "claude") {
    return "Settings › Hub accounts › Claude for the hub's API key; Settings › Your accounts › Claude for your own subscription";
  }
  const names: Record<string, string> = {
    github: "Hub accounts › GitHub",
    invites: "Hub › People",
    people: "Hub › People",
    machines: "Hub › Machines",
    onepassword: "Your accounts › 1Password",
  };
  return `Settings › ${names[place] ?? place}`;
}

/** The step as a guide: why, its numbered parts, and what happens after. */
export function guide(step: any): string {
  const out: string[] = [step.why];
  (step.parts ?? []).forEach((part: any, n: number) => {
    out.push("");
    out.push(`${n + 1}. ${part.title}${part.optional === true ? " (optional)" : ""}`);
    if (part.note) out.push(`   ${part.note}`);
    for (const link of part.links ?? []) out.push(`   ${link.label}: ${link.url}`);
    for (const v of part.values ?? []) {
      if (v.plain === true) out.push(`   ${v.label}: ${v.value}`);
      else {
        out.push(`   ${v.label}:`);
        out.push(...String(v.value).split("\n").map((l) => `     ${l}`));
      }
      if (v.note) out.push(`     ${v.note}`);
    }
  });
  const after = step.fieldsNote ?? (step.place ? `In the app: ${placeWords(step.place)}.` : undefined);
  if (after) out.push("", after);
  if (step.test) out.push("", `Test: ${String(step.test).replace(/\.+$/, "")}.`);
  return out.join("\n");
}
