// The reads every project's settings page makes for its sections (Linked hubs, Approvals, Integrations, Payments),
// answered empty where a fixture hasn't answered them itself: a settings page of any project loads whole.
import { PROJECT_TOOLS } from "../../src/renderer/screens/projects/model.ts";
import type { Fixture } from "./fixture.ts";
import type { JsonObject, JsonValue } from "./json.ts";

const BOX = "Az+6kf/abi0V7SO+sn4h++sIgyPoNDAneLBDFaJf3TA=";
// The mode a new project starts in (W588).
const YOLO = { mode: "yolo", model: "claude-sonnet-5-5", effort: "medium", defaults: true };

export const projectSections = (f: Fixture, ref: { readonly machineId: string; readonly projectId: string }): void => {
  const own = { machineId: ref.machineId, projectId: ref.projectId };
  const reads: ReadonlyArray<[string, JsonObject, JsonValue]> = [
    ["hub_links_get", { navi: own }, { boxPubKey: BOX, issued: [], links: [] }],
    [PROJECT_TOOLS.approvals, own, { approvals: YOLO, log: [] }],
    ["mcp_servers_get", { project: own }, { global: [], project: [], userServers: true }],
    [PROJECT_TOOLS.purchases, own, { purchases: [] }],
  ];
  for (const [tool, input, output] of reads) if (f.output(tool, input) === undefined && f.output(tool) === undefined) f.answer(tool, input, output);
};
