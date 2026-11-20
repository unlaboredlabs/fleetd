// The controls a setup step's page holds, by the step's id: the hub's own accounts (its Claude API key and endpoint,
// its GitHub App), the same on Settings › Hub › Setup's step page and, for Claude, on the first run's step, so it is
// done right there.
import type { ReactNode } from "react";
import type { Person } from "../../../shared/contracts";
import { ClaudeAdmin } from "../admin/Claude";
import { AdminGithub } from "../github/AdminGithub";

/** The steps whose controls the first run holds too. */
export const INLINE: ReadonlySet<string> = new Set(["claude"]);

export function stepControls(id: string, me: Person | undefined): ReactNode {
  if (id === "claude") return <ClaudeAdmin me={me} />;
  if (id === "github") return <AdminGithub />;
  return undefined;
}
