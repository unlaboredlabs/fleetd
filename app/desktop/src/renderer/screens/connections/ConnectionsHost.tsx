// Mounted once by the shell, in the hub's frame: Connections, a sheet over whatever is on screen. `#/connections`
// (links, Settings search, the QA harness) opens it and gives the address back to the screen behind, which stays
// mounted as it was, so Back never reopens it; the palette has it as a command.
import { lazy, Suspense, useEffect, useMemo } from "react";
import { useCommands, type Command } from "../palette";
import { screenHash } from "../shell/navigation";
import { parseHash } from "../shell/routes";
import { closeConnections, openConnections, useConnectionsOpen } from "./state";

// Its own chunk, loaded the first time it opens.
const ConnectionsSheet = lazy(() => import("./ConnectionsSheet").then((m) => ({ default: m.ConnectionsSheet })));

export function ConnectionsHost() {
  const open = useConnectionsOpen();
  useEffect(() => {
    const take = () => {
      if (parseHash(window.location.hash).id !== "connections") return;
      openConnections();
      window.location.replace(screenHash() || "#/");
    };
    take();
    window.addEventListener("hashchange", take);
    return () => window.removeEventListener("hashchange", take);
  }, []);
  const commands = useMemo<ReadonlyArray<Command>>(
    () => [
      {
        id: "go:connections",
        title: "Connections",
        group: "go-to",
        keywords: ["connect", "integrations", "mcp", "mcp servers", "paper", "notion", "tailscale", "tailnet", "oauth", "apps"],
        run: openConnections,
      },
    ],
    [],
  );
  useCommands(commands, []);
  return open ? (
    <Suspense fallback={null}>
      <ConnectionsSheet onClose={closeConnections} />
    </Suspense>
  ) : null;
}
