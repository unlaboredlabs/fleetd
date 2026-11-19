// The controls a setup step's page holds, by the step's id: the hub's own accounts (its Claude API key and endpoint,
// its GitHub App) and its Tailscale device, the same on Settings › Hub › Setup's step page and, for Tailscale and
// Claude, on the first run's step, so either is done right there.
import type { ReactNode } from "react";
import type { Person } from "../../../shared/contracts";
import { ClaudeAdmin } from "../admin/Claude";
import { AdminGithub } from "../github/AdminGithub";
import { TailscaleSection } from "../settings/Tailscale";

/** The steps whose controls the first run holds too: Tailscale, and Claude right after it. */
export const INLINE: ReadonlySet<string> = new Set(["tailscale", "claude"]);

export function stepControls(id: string, me: Person | undefined): ReactNode {
  if (id === "claude") return <ClaudeAdmin me={me} />;
  if (id === "github") return <AdminGithub />;
  if (id === "tailscale") return <TailscaleSection title={null} />;
  return undefined;
}
