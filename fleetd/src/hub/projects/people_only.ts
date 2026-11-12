// What a lead's setup calls (repo_add, repo_remove, project_setup) never do, because it guards people: each thing,
// the names an agent might send for it, and the one line it is refused with, saying who can do it and where. The
// calls have no field for any of them (W614, D442): a field named here is refused before anything else is read, to a
// lead and to a task alike.
import { ToolError } from "../../shared/errors.ts";

export type PeopleOnly =
  | "approval_mode"
  | "sites"
  | "agents"
  | "card"
  | "vault"
  | "mcp_servers"
  | "prompts"
  | "hub_links"
  | "delete"
  | "create"
  | "another_project"
  | "project_folder";

/** Who can do it and where, in one line. */
export const PEOPLE_ONLY: Record<PeopleOnly, string> = {
  approval_mode: "Only a person changes a project's approval mode: in the app, the chat's menu or the project's settings.",
  sites: "Only a person allows a site: they answer the card its first visit shows, or add it in the project's settings in the app.",
  agents: "Only a person picks a project's profiles and models and sets its max agents: Settings › Projects › Agents in the app.",
  card: "Only a person gives a project a card: the project's Vault in the app, on their own device.",
  vault: "Only a person adds, changes or removes vault items: Settings › You › Vault or the project's Vault in the app. For a secret you need, call request_secret.",
  mcp_servers: "Only a person adds or removes MCP servers: Settings › Hub › Every project › Tools & skills, or the project's own settings, in the app.",
  prompts: "Only a person edits prompts: the project's settings › Prompts in the desktop app. The project's Instructions are yours to write: project_setup with instructions.",
  hub_links: "Only a person links hubs: Settings › You › Hubs in the app.",
  delete: "Only a person deletes a project: its settings in the app, or `fleetd project remove` from their own terminal. Archiving it is yours: project_setup with archive: true.",
  create:
    "Only a person creates a project. When they ask you for one, propose it with project_propose: their Approve on its card makes it, as theirs. Or they make it themselves: New project in the app, or `fleetd project add` from their own terminal.",
  another_project: "A lead sets up only its own project. Another project is set up by its own lead (project_message writes to it) or by a person in the app.",
  project_folder: "That folder is a project of its own, and adding it as a repo would archive that project: only a person does that, in this project's settings in the app.",
};

/** The names a call might carry for each, lowercase with nothing but letters and digits. */
const NAMES: Record<PeopleOnly, string[]> = {
  approval_mode: ["approvalmode", "approvals", "approval", "mode", "permissionmode", "yolo"],
  sites: ["sites", "site", "allowedsites", "allowsite", "allowsites"],
  agents: ["profile", "profiles", "model", "models", "maxagents", "agentlimit", "effort"],
  card: ["card", "cards", "paymentcard"],
  vault: ["vault", "vaultitem", "vaultitems", "secret", "secrets", "login", "logins"],
  mcp_servers: ["mcp", "mcpserver", "mcpservers"],
  prompts: ["prompt", "prompts"],
  hub_links: ["hublink", "hublinks", "linkedhub", "linkedhubs", "hubs"],
  delete: ["delete", "deleted", "remove", "destroy"],
  create: ["create", "new", "createproject", "newproject"],
  another_project: ["project", "projectid", "projectref", "machine", "machineid"],
  project_folder: [],
};

const BY_NAME = new Map(Object.entries(NAMES).flatMap(([thing, names]) => names.map((n) => [n, thing as PeopleOnly] as const)));

/** The ops whose calls are checked for people-only fields. */
export const SETUP_OPS: readonly string[] = ["repo_add", "repo_remove", "project_setup"];

/** The refusal for `thing`. `detail` goes first, for what the line alone doesn't name. */
export const peopleOnly = (thing: PeopleOnly, detail?: string) =>
  new ToolError("forbidden", detail === undefined ? PEOPLE_ONLY[thing] : `${detail} ${PEOPLE_ONLY[thing]}`);

/** The first people-only thing a setup call's fields name, as sent (before unnamed fields are dropped). */
export function namedIn(call: unknown): { thing: PeopleOnly; field: string } | undefined {
  if (typeof call !== "object" || call === null) return undefined;
  for (const field of Object.keys(call)) {
    const thing = BY_NAME.get(field.toLowerCase().replace(/[^a-z0-9]/g, ""));
    if (thing) return { thing, field: field.slice(0, 60) };
  }
  return undefined;
}
