// The package's `fleetd/tools` (docs/CONTRIBUTING.md "The package"): the hub's MCP tools as a second server lists and
// decodes them, joined from where the hub keeps them: each tool's role (src/hub/api/tool_roles.ts), its description
// (src/hub/mcp/descriptions.ts) and its schemas (the contracts' McpTools.json). Nothing in the hub imports this file.
// Read as text, as the hub reads it (src/hub/api/decode.ts says why).
import schemaText from "../../../app/desktop/src/shared/contracts/schema/McpTools.json" with { type: "text" };
import type { Role } from "../shared/contracts.ts";
import { TOOLS, type ToolName } from "../hub/api/tool_roles.ts";
import { DESCRIPTIONS } from "../hub/mcp/descriptions.ts";

export { TOOLS, type ToolName } from "../hub/api/tool_roles.ts";
export { DESCRIPTIONS } from "../hub/mcp/descriptions.ts";
export { DecodeError, decodeInput, hasInput } from "../hub/api/decode.ts";

export type JsonSchema = { [key: string]: unknown };

/** McpTools.json, parsed: a tool's schemas are `$defs.McpTools.properties["<tool>.input"]` and `["<tool>.output"]`. */
export const SCHEMAS = JSON.parse(schemaText) as { $defs: Record<string, JsonSchema> };

export type Tool = {
  name: ToolName;
  /** Empty for a tool the table doesn't describe. */
  description: string;
  /** The least role a caller needs. */
  scope: Role;
  /** As McpTools.json has them: mostly a `$ref` into `SCHEMAS.$defs`. */
  input: JsonSchema;
  output: JsonSchema;
};

const schemas = (SCHEMAS.$defs.McpTools?.properties ?? {}) as Record<string, JsonSchema>;
const described = new Map(DESCRIPTIONS);
const names = Object.keys(TOOLS) as ToolName[];

/** Every tool, in the order the hub's tools/list gives them: the described ones in the table's order, then the rest sorted. */
export const TOOL_LIST: Tool[] = [
  ...DESCRIPTIONS.map(([name]) => name as ToolName).filter((name) => name in TOOLS),
  ...names.filter((name) => !described.has(name)).sort(),
].map((name) => ({
  name,
  description: described.get(name) ?? "",
  scope: TOOLS[name].scope,
  input: schemas[`${name}.input`] ?? {},
  output: schemas[`${name}.output`] ?? {},
}));
