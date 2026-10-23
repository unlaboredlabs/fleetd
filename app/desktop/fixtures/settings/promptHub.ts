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

/** prompt_get's `orphans` entry (PT's RetiredPromptOverride). */
export interface Orphan {
  id: string;
  title: string;
  scope: Scope;
  projectRef?: ProjectRef;
  text: string;
  suggestedTarget?: string;
  why: string;
}

export class PromptHub {
  readonly prompts: Prompt[];
  retentionDays = 30;
  readonly storedBytes = 184_320_000;
  /** Set to make every call fail as if the hub dropped; the tests and the error fixtures use it. */
  offline = false;

  /** `edits: false` is a hub nobody has edited a prompt on. */
  /** Edits of prompts this hub no longer has (prompt trim): listed under prompt_get's `orphans`, deleted by reset. */
  orphans: Orphan[] = [];

  constructor(registry: ReadonlyArray<RegistryEntry>, { edits = true } = {}) {
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

    if (edits) {
      this.orphans = [
        {
          id: "wake.task_result",
          title: "Wake: task finished",
          scope: "global",
          text: "- {{taskId}} {{verb}}: {{title}}{{where}}\n  Before you spawn a follow-up, read the result in full and say in one line what it changes for the plan.\n",
          suggestedTarget: "lead.start",
          why: "wakes are now a fixed event format",
        },
        {
          id: "router",
          title: "Order router",
          scope: "project",
          projectRef: { machineId: "devbox", projectId: "storefront" },
          text: "Route anything about checkout or payments to storefront, never to docs-site.",
          why: "orders are now written to a project's lead in its chat, so nothing routes them",
        },
      ];
    }
    if (!edits) {
      const own = this.get(INSTRUCTIONS);
      own.global = null;
      own.projects.clear();
      return;
    }
    // The release before this one shipped the lead prompt without its last paragraph; the human edited that text,
    // adding a line after its first paragraph.
    const lead = this.get("lead.start");
    const paragraphs = lead.text.trimEnd().split("\n\n");
    const older = `${paragraphs.slice(0, -1).join("\n\n")}\n`;
    const [first = "", ...rest] = older.split("\n\n");
    lead.global = {
      text: [first, "Prefer one writer per pull request; split anything bigger into several tasks.", ...rest].join("\n\n"),
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
      case "project_get":
        return { ok: true, output: { projects: PROJECTS } };
      case "prompt_get": {
        if (input["id"] === undefined) {
          const orphans = this.orphans.filter((o) => o.scope !== "project" || (o.projectRef !== undefined && keyOf(o.projectRef) === key));
          return { ok: true, output: { prompts: this.prompts.map((p) => this.summary(p, key)), orphans } };
        }
        const p = find();
        return p ? { ok: true, output: { prompt: this.detail(p, key) } } : notFound(input["id"]);
      }
      case "prompt_set": {
        if (typeof input["text"] !== "string") return this.reset(input, key);
        const p = find();
        if (!p) return notFound(input["id"]);
        const text = input["text"];
        if (text === "" && p.id !== INSTRUCTIONS) return { ok: false, error: { code: "invalid", message: "A prompt can't be empty." } };
        const warnings = this.warnings(p, text);
        if (input["dryRun"] !== true) {
          // As the hub: the default the text was written against, which keeps the edit stale until it is today's.
          const base = typeof input["base"] === "string" ? this.textOf(p, input["base"]) : p.text;
          const edit = { text, base };
          if (input["scope"] === "project" && key && p.perProject) p.projects.set(key, edit);
          else p.global = edit;
        }
        return { ok: true, output: { ref: refOf(p.id, text), warnings } };
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

  /** prompt_set without text: an orphan deleted, or the override at the scope gone. */
  private reset(input: Record<string, unknown>, key: string | null): Answer {
    const gone = this.orphans.findIndex((o) => o.id === input["id"] && o.scope === input["scope"]);
    if (gone >= 0) {
      this.orphans.splice(gone, 1);
      return { ok: true, output: { ref: `${String(input["id"])}@0000000000`, warnings: [] } };
    }
    const p = this.prompts.find((x) => x.id === input["id"]);
    if (!p) return notFound(input["id"]);
    if (input["scope"] === "project" && key) p.projects.delete(key);
    else p.global = null;
    return { ok: true, output: { ref: this.version(p, this.effective(p, key)[0]).ref, warnings: [] } };
  }

  /** The text of one of the prompt's versions this hub knows, by ref; null for a ref it never shipped. */
  private textOf(p: Prompt, ref: string): string | null {
    const known = [p.text, p.global?.base, p.global?.text, ...[...p.projects.values()].flatMap((e) => [e.base, e.text])];
    return known.find((t): t is string => typeof t === "string" && refOf(p.id, t) === ref) ?? null;
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
      stale: edit !== null && edit.base !== p.text && p.kind !== "playbook" && p.id !== INSTRUCTIONS,
    };
  }

  private detail(p: Prompt, key: string | null) {
    const [text, scope, edit] = this.effective(p, key);
    const stale = edit !== null && edit.base !== p.text && p.kind !== "playbook" && p.id !== INSTRUCTIONS;
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
