// A bot's Connections, on its Bot page under "What its lead can use": what the bot uses now, in one line (Paper,
// Notion, a custom MCP by name), and Open, which opens Connections over Settings. Its MCP servers list was here
// before Connections (D653): a link to it (`projects.mcp`) lands on this row.
import type { McpServer } from "../../../shared/contracts";
import { useToolQuery } from "../../src/data/react";
import { Button } from "../../ui";
import { useLive } from "../settings/hub";
import { namedOf } from "../settings/namedServers";
import { SettingsRow } from "../settings/parts";
import { usable, usedBy } from "./model";
import { openConnections } from "./state";

/** What a bot uses, by name: the named services first as they are called, then the rest by server name. */
export const usesLine = (servers: ReadonlyArray<McpServer>, bot: { machineId: string; projectId: string }): string | null => {
  const used = servers.filter((s) => usable(s) && usedBy(s, bot));
  if (used.length === 0) return null;
  const names = [...used.flatMap((s) => namedOf(s)?.label ?? []), ...used.filter((s) => namedOf(s) === undefined).map((s) => s.name)];
  return names.length <= 3 ? names.join(", ") : `${names.slice(0, 2).join(", ")} and ${String(names.length - 2)} more`;
};

export function BotConnections({ projectRef }: { projectRef: { machineId: string; projectId: string } }) {
  const live = useLive();
  const read = useToolQuery("mcp_servers_get", { project: projectRef }, { enabled: live });
  const own = read.data?.project ?? [];
  // A bot's own server replaces the team's of the same name for it.
  const servers = [...own, ...(read.data?.global ?? []).filter((g) => !own.some((p) => p.name === g.name))];
  const line = read.data === undefined ? null : (usesLine(servers, projectRef) ?? "None yet.");
  return (
    <SettingsRow
      reveal="projects.mcp"
      title="Connections"
      hint="Paper, Notion, Tailscale and custom MCPs: what this bot's lead and agents can use."
      line={line}
      control={
        <Button size="sm" onClick={openConnections} data-opens="connections">
          Open
        </Button>
      }
    />
  );
}
