// The profile a task runs on.
import type { TaskKind } from "../../shared/contracts.ts";

/**
 * The spawn's profile, the hub's default when it names none: `allowed` is what the project allows, the default first.
 * A review task always runs on the default. A profile the project doesn't allow is refused, naming the ones it does.
 * Throws the refusal's words.
 */
export function resolveProfile(spawn: string | undefined, kind: TaskKind, allowed: string[]): string {
  const fallback = allowed[0];
  if (fallback === undefined) throw new Error("the hub's profiles were not read");
  if (kind === "review" || spawn === undefined) return fallback;
  if (allowed.includes(spawn)) return spawn;
  throw new Error(`this project doesn't allow profile ${spawn}; it allows ${allowed.join(", ")}`);
}
