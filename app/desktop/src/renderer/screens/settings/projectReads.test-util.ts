// The reads every project's settings page makes for its sections (Telegram, Linked hubs, Approvals, Integrations,
// Payments), answered empty: for a test of one part of the page whose fake hub answers only its own calls.
import { PROJECT_TOOLS } from "../projects/model";

const EMPTY: Readonly<Record<string, unknown>> = {
  telegram_get: {},
  hub_links_get: { boxPubKey: "A".repeat(43) + "=", issued: [], links: [] },
  [PROJECT_TOOLS.approvals]: { approvals: { mode: "checker", model: "claude-sonnet-5-5", effort: "medium", defaults: true }, log: [] },
  mcp_servers_get: { global: [], project: [], userServers: true },
  [PROJECT_TOOLS.purchases]: { purchases: [] },
};

/** The empty answer to one of the page's section reads; undefined for any other call. */
export const sectionRead = (tool: string): { ok: true; output: unknown } | undefined => (tool in EMPTY ? { ok: true, output: EMPTY[tool] } : undefined);
