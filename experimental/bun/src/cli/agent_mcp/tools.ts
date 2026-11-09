// agent-mcp's tools (crates/fleetd/src/cli/agent_mcp.rs `TOOLS`): which role sees each, the lead or browser call it
// makes, and what tools/list shows. The descriptions and schemas are the Rust binary's own, from tools.json
// (snapshot.ts writes it): schemars renders the schemas from the contracts' Rust types, which have no TypeScript twin.
import snapshotJson from "./tools.json" with { type: "json" };

export type Role = "lead" | "worker";

/** How the Rust binary refuses a bad value at one field (snapshot.ts probes each). */
export interface Probe {
  /** serde's "invalid type: …, expected <this>". */
  expected?: string;
  /** Every variant the field takes, in the Rust enum's order (the schema may list fewer: `ios` left session_start). */
  variants?: string[];
  /** A brand's refusal of a value its pattern doesn't match, with `{got}` for the value's `{:?}`. */
  pattern?: string;
  /** An integer field's refusal of a fraction, and of a value below its minimum. */
  fraction?: string;
  range?: string;
  /** A struct's fields in the Rust struct's order, which it takes them in when given as a sequence. */
  fields?: string[];
}

export interface ToolSpec {
  name: string;
  /** The lead call's `op`, or the browser call's. */
  op: string;
  lead: boolean;
  worker: boolean;
  /** A browser call (`browser_call`), which the node answers itself: its broker runs the session's browser. */
  browser: boolean;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface Snapshot {
  /** `fleetd version` of the Rust binary it came from. */
  rust: string;
  tools: ToolSpec[];
  /** By tool, then by field path (`/items/*\/id`). */
  probes: Record<string, Record<string, Probe>>;
}

export const SNAPSHOT = snapshotJson as Snapshot;

/** The server's name in a session's `--mcp-config`; claude shows its tools as `mcp__fleetd__<name>`. */
export const SERVER_NAME = "fleetd";

/** Tools that left the list, and the listed tool each one's calls go to with the same arguments: an older lead or
 * skill may still name them. One release, then they go. */
export const ALIASES: [string, string][] = [
  ["automation_pause", "automation_update"],
  ["chat_image", "chat_file"],
];

/** What a person must do before a tool's call takes effect, by tool; a tool missing here needs nothing. */
export const HUMAN: Record<string, string> = {
  request_secret: "The human enters the value in chat; you see only its fingerprint.",
  gated_run: "A human approves the exact command in chat before the node runs it.",
  request_secure_input: "The person enters the value in a sealed field; a 1Password field fills with no ask.",
};

export const toolsFor = (role: Role) => SNAPSHOT.tools.filter((t) => (role === "lead" ? t.lead : t.worker));

/** The `tools/list` answer for `role`. */
export const toolList = (role: Role) => ({
  tools: toolsFor(role).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
});

type Call = Record<string, unknown>;
const some = (value: unknown) => value !== undefined && value !== null;

/** The contracts' `checked!` rules on these calls, by tool and the path of the struct they check (`""` the call
 * itself): each runs once its struct's fields have decoded, as the Rust impl does. */
export const RULES: Record<string, Record<string, (call: Call) => string | undefined>> = {
  // lead_calls.rs TaskSpawnCall, tasks.rs task_spawn_rule.
  spawn_agent: {
    "": (call) => {
      const kind = call.kind ?? "write";
      if (kind === "review" && !some(call.pr)) return "a review task needs --pr <PR URL>";
      if (call.qa === true && kind !== "review") return "--qa applies only to --kind review";
      if (some(call.notDuplicateOf) && !some(call.notDuplicateWhy)) {
        return "notDuplicateOf needs notDuplicateWhy: one line on why it is different work";
      }
    },
  },
  // lead_calls.rs BriefCreateCall.
  brief: {
    "": (call) => {
      if (!some(call.workstreamId) && !some(call.text)) {
        return "give workstreamId to brief an open workstream, or text to open one";
      }
      if (some(call.workstreamId) && some(call.text)) return "text opens a workstream; leave it out with workstreamId";
    },
  },
  // lead_calls.rs RequestSecretCall.
  request_secret: {
    "": (call) => {
      const sink = String(call.sink);
      if (some(call.envName) && !sink.startsWith("env:") && !sink.startsWith("order:")) {
        return "only an env: or order: sink has an env name";
      }
    },
  },
  // memory.rs RememberCall, ForgetCall.
  remember: { "": (call) => userTopic(call) },
  forget: { "": (call) => userTopic(call) },
  // checklist.rs TodoEdit, ChecklistCall.
  checklist: {
    "/items/*": (edit) => {
      const removing = edit.remove === true;
      if (!some(edit.id)) {
        if (removing) return "remove needs the item's id";
        if (!some(edit.text)) return "a new item needs text";
        return;
      }
      if (removing && (some(edit.text) || some(edit.state) || some(edit.link))) return "remove takes only the id";
      if (!removing && !some(edit.text) && !some(edit.state) && !some(edit.link)) {
        return "give text, state, link or remove with an id";
      }
    },
    "": (call) => {
      const items = (call.items ?? []) as Call[];
      if (call.replace === true) {
        if (items.some((edit) => some(edit.id))) return "replace sets the whole list: leave ids out";
      } else if (items.length === 0) {
        return "give items to change, or replace to set the whole list";
      }
    },
  },
};

function userTopic(call: Call): string | undefined {
  if (call.scope === "user" && some(call.topic)) return "user.md has no topics; leave topic out with scope user";
}
