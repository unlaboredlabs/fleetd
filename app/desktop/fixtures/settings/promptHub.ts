// A stand-in for the hub's Settings tools, answering the way the hub does: the real registry of this fleetd (ids,
// titles, placeholders, safety rules and default texts, from src/renderer/screens/settings/fixture/registry.json,
// which the Settings tests also read), hub-wide and per-project edits, dry-run warnings, and one edit made against an
// older default so the Update view has something to show. The settings fixtures record its answers; the preview and
// tests can drive it directly. Projects are the fixture's own (acme/* on devbox and buildbox).
//
// Shapes follow fleetd_contracts::prompts; `pnpm fixtures` validates every recorded answer against the schema.

export const INSTRUCTIONS = "instructions";

type Scope = "default" | "global" | "project";
type Enforced = "code" | "prompt";

interface Placeholder {
  name: string;
  required: boolean;
  description: string;
}

interface Rule {
  id: string;
  label: string;
  needle: string;
  enforced: Enforced;
}

interface Warning {
  code: "placeholder_missing" | "placeholder_unknown" | "safety_rule_missing" | "too_long";
  message: string;
  placeholder?: string;
  rule?: string;
  enforced?: Enforced;
}

interface Version {
  ref: string;
  text: string;
}

export interface ProjectRef {
  machineId: string;
  projectId: string;
}

/** One entry of registry.json. */
export interface RegistryEntry {
  id: string;
  kind: string;
  group: string;
  title: string;
  sentWhen: string;
  perProject: boolean;
  placeholders: Placeholder[];
  rules: Rule[];
  text: string;
}

type Entry = RegistryEntry;

interface Edit {
  text: string;
  /** The default text it was edited from. */
  base: string | null;
}

interface Prompt extends Entry {
  global: Edit | null;
  projects: Map<string, Edit>;
}

export const PROJECTS: ReadonlyArray<ProjectRef & { title: string }> = [
  { machineId: "devbox", projectId: "storefront", title: "acme/storefront" },
  { machineId: "devbox", projectId: "docs-site", title: "acme/docs-site" },
  { machineId: "buildbox", projectId: "payments-api", title: "acme/payments-api, the service behind checkout and refunds" },
];

const TOO_LONG = 12_000;

/** FNV-1a as a stand-in for git's blob SHA: stable, and enough to tell texts apart. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h.toString(16).padStart(8, "0") + "00").slice(0, 10);
}

const refOf = (id: string, text: string) => `${id}@${hash(text)}`;
const keyOf = (r: ProjectRef | undefined) => (r ? `${r.machineId}/${r.projectId}` : null);

export type Answer = { ok: true; output: unknown } | { ok: false; error: { code: string; message: string; fix?: string } };

export class PromptHub {
  readonly prompts: Prompt[];
  retentionDays = 30;
  readonly storedBytes = 184_320_000;
  /** Set to make every call fail as if the hub dropped; the tests and the error fixtures use it. */
  offline = false;

  constructor(registry: ReadonlyArray<RegistryEntry>) {
    this.prompts = registry.map((e) => ({ ...e, global: null, projects: new Map() }));
    this.prompts.push({
      id: INSTRUCTIONS,
      kind: "instructions",
      group: "instructions",
      title: "Custom instructions",
      sentWhen: "appended to every lead and task first message, global then project",
      perProject: true,
      placeholders: [],
      rules: [],
      text: "",
      global: { text: "Keep pull requests under 400 changed lines; split bigger work.\n\nWrite commit messages in plain language.\n", base: "" },
      projects: new Map([["devbox/storefront", { text: "Use pnpm, not npm. The staging site is https://staging.storefront.test.\n", base: "" }]]),
    });

    // The release before this one shipped the lead prompt without its status line; the human edited that text.
    const lead = this.get("lead.start");
    const statusLine = lead.text.split("\n").find((l) => l.includes("fleetd status set")) ?? "";
    const older = lead.text.replace(`${statusLine}\n`, "");
    lead.global = {
      text: older.replace("How you work:\n", "How you work:\n- Prefer one writer per pull request; split anything bigger into several tasks.\n"),
      base: older,
    };
    // storefront's own writer brief, and a hub-wide reviewer edit.
    const brief = this.get("task.brief.write");
    brief.projects.set("devbox/storefront", { text: `${brief.text.trimEnd()}\n\nRun \`pnpm test\` before you open the pull request.\n`, base: brief.text });
    const reviewer = this.get("review.reviewer");
    reviewer.global = { text: reviewer.text.replace(/\n*$/u, "\n\nBe brief: blocking findings first, then at most three nits.\n"), base: reviewer.text };
  }

  get(id: string): Prompt {
    const p = this.prompts.find((x) => x.id === id);
    if (!p) throw new Error(`no prompt ${id}`);
    return p;
  }

  answer(tool: string, input: Record<string, unknown>): Answer {
    if (this.offline) return { ok: false, error: { code: "disconnected", message: "The hub connection dropped." } };
    const project = input["projectRef"] as ProjectRef | undefined;
    const key = keyOf(project);
    const find = (): Prompt | null => this.prompts.find((p) => p.id === input["id"]) ?? null;
    switch (tool) {
      case "projects_list":
        return { ok: true, output: { projects: PROJECTS } };
      case "prompts_list":
        return { ok: true, output: { prompts: this.prompts.map((p) => this.summary(p, key)) } };
      case "prompt_get": {
        const p = find();
        return p ? { ok: true, output: this.detail(p, key) } : notFound(input["id"]);
      }
      case "prompt_set": {
        const p = find();
        if (!p) return notFound(input["id"]);
        const text = typeof input["text"] === "string" ? input["text"] : "";
        if (text === "" && p.id !== INSTRUCTIONS) return { ok: false, error: { code: "invalid", message: "A prompt can't be empty." } };
        const warnings = this.warnings(p, text);
        if (input["dryRun"] !== true) {
          const edit = { text, base: p.text };
          if (input["scope"] === "project" && key && p.perProject) p.projects.set(key, edit);
          else p.global = edit;
        }
        return { ok: true, output: { ref: refOf(p.id, text), warnings } };
      }
      case "prompt_reset": {
        const p = find();
        if (!p) return notFound(input["id"]);
        if (input["scope"] === "project" && key) p.projects.delete(key);
        else p.global = null;
        const [text, scope] = this.effective(p, key);
        return { ok: true, output: { effective: this.version(p, text), scope } };
      }
      case "time_breakdown":
        return { ok: true, output: { retentionDays: this.retentionDays, storedBytes: this.storedBytes } };
      case "time_retention_set":
        this.retentionDays = Number(input["retentionDays"]);
        return { ok: true, output: { retentionDays: this.retentionDays } };
      default:
        return { ok: false, error: { code: "not_found", message: `The fixture hub has no ${tool}.` } };
    }
  }

  private version(p: Prompt, text: string): Version {
    return { ref: refOf(p.id, text), text };
  }

  private override(p: Prompt, e: Edit | null | undefined): (Version & { base?: string }) | undefined {
    if (!e) return undefined;
    return { ref: refOf(p.id, e.text), text: e.text, ...(e.base !== null ? { base: refOf(p.id, e.base) } : {}) };
  }

  private effective(p: Prompt, key: string | null): [string, Scope, Edit | null] {
    const own = key && p.perProject ? p.projects.get(key) : undefined;
    if (own) return [own.text, "project", own];
    if (p.global) return [p.global.text, "global", p.global];
    return [p.text, "default", null];
  }

  private summary(p: Prompt, key: string | null) {
    const [text, scope, edit] = this.effective(p, key);
    return {
      id: p.id,
      title: p.title,
      kind: p.kind,
      group: p.group,
      sentWhen: p.sentWhen,
      scope,
      defaultRef: refOf(p.id, p.text),
      ...(scope !== "default" ? { overrideRef: refOf(p.id, text) } : {}),
      stale: edit !== null && edit.base !== null && edit.base !== p.text && p.id !== INSTRUCTIONS,
    };
  }

  private detail(p: Prompt, key: string | null) {
    const [text, scope, edit] = this.effective(p, key);
    const stale = edit !== null && edit.base !== null && edit.base !== p.text && p.id !== INSTRUCTIONS;
    const global = this.override(p, p.global);
    const project = this.override(p, key ? p.projects.get(key) : undefined);
    return {
      id: p.id,
      title: p.title,
      kind: p.kind,
      group: p.group,
      sentWhen: p.sentWhen,
      perProject: p.perProject,
      default: this.version(p, p.text),
      ...(global ? { global } : {}),
      ...(project ? { project } : {}),
      scope,
      effective: this.version(p, text),
      placeholders: p.placeholders,
      safetyRules: p.rules.map((r) => ({ ...r, present: new RegExp(r.needle, "iu").test(text) })),
      warnings: this.warnings(p, text),
      ...(stale
        ? {
            stale: {
              scope,
              ...(edit.base !== null ? { base: this.version(p, edit.base) } : {}),
              current: this.version(p, p.text),
              yours: this.version(p, edit.text),
              merged: merge(edit.base ?? "", p.text, edit.text),
              conflicts: false,
            },
          }
        : {}),
    };
  }

  private warnings(p: Prompt, text: string): Warning[] {
    const out: Warning[] = [];
    const used = new Set([...text.matchAll(/\{\{(\w+)\}\}/gu)].map((m) => m[1] ?? ""));
    for (const ph of p.placeholders) {
      if (ph.required && !used.has(ph.name)) {
        out.push({ code: "placeholder_missing", message: `{{${ph.name}}} is missing: ${ph.description} won't reach the agent.`, placeholder: ph.name });
      }
    }
    for (const name of used) {
      if (!p.placeholders.some((ph) => ph.name === name)) {
        out.push({ code: "placeholder_unknown", message: `{{${name}}} is not a placeholder of this prompt; it is sent as written.`, placeholder: name });
      }
    }
    for (const r of p.rules) {
      if (!new RegExp(r.needle, "iu").test(text)) {
        out.push({ code: "safety_rule_missing", message: `The text no longer says that it ${r.label}.`, rule: r.id, enforced: r.enforced });
      }
    }
    if (text.length > TOO_LONG) out.push({ code: "too_long", message: `This text is ${text.length} characters; agents get the most from under ${TOO_LONG}.` });
    return out;
  }
}

function notFound(id: unknown): Answer {
  return { ok: false, error: { code: "not_found", message: `No prompt ${String(id)}.` } };
}

/** A line merge good enough for the fixture: the new default with the lines yours added that the default lacks. */
function merge(base: string, current: string, yours: string): string {
  const baseLines = new Set(base.split("\n"));
  const out = current.split("\n");
  const added = yours.split("\n").filter((l) => !baseLines.has(l));
  const at = out.findIndex((l) => l.startsWith("How you work:"));
  out.splice(at >= 0 ? at + 1 : out.length, 0, ...added);
  return out.join("\n");
}
