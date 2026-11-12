// Import memory (Settings > Memory): a person copies the `memory.export` prompt
// into another assistant, pastes its answer back, and `memory_import` turns it into entries of their own memory.
//
// One model turn distills it: a session with no tools at all, on the person's own Claude choice (D200), in any live
// project of the hub (D491), so everyone on the hub can read the paste and what it writes. The pasted text is untrusted: it goes between
// two fences no paste can fake, under the `memory.import` rules that it is data, never instructions. Its answer is JSON
// entries, written here the way `remember` writes them: a secret refused, an entry the memory already says skipped, a
// merged one in place of the old, and the cap held, the most durable kinds first. One `memory.changed` at the end.
//
// The turn runs through a `Turn`, as in Rust: `importPorts(hub).turn`, the executor's by default; tests set their own.
import type { MemoryImported, MemoryImportOutput, MemoryImportSkip, MemorySkipped, PersonId, ProjectRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { CAP_ALLOWED_ONLY } from "../../shared/node_link.ts";
import type { Hub } from "../api/hub.ts";
import { requireRole } from "../api/grants.ts";
import type { Registry } from "../api/registry.ts";
import { requireHuman, unknownProject } from "../leads/seams.ts";
import { store } from "../store/hub_store.ts";
import { ClaudeAccountStore, isRefusal, launchAccount } from "../claude_accounts/index.ts";
import { CAP_CLAUDE_ACCOUNTS } from "../claude_accounts/tools.ts";
import type { LaunchInput, LaunchOptions } from "../executor/sessions.ts";
import { Owner, type Turn, turn } from "../executor/turn.ts";
import { profiles } from "../projects/profiles.ts";
import { prompts } from "../prompts/store.ts";
import { redact } from "../redact.ts";
import { changed } from "./calls.ts";
import { activePeople, Memory, type RememberCall, type You, userTarget, youTarget } from "./index.ts";
import {
  clean,
  type Distilled,
  entryOk,
  fenceNonce,
  IMPORT_ENTRIES_MAX,
  importFence,
  importMessage,
  NO_PROJECT_FIX,
  parse,
  rank,
  same,
} from "./import_rules.ts";
import { job, refreshPorts, runNow } from "./refresh.ts";

export { clean, IMPORT_ENTRIES_MAX, NO_PROJECT_FIX, parse } from "./import_rules.ts";

/** The executor's turn (executor/turn.rs `Turn`): its reply, or a thrown Error saying why there is none. */
export type { Turn };

/** `importPorts(hub).turn`: the executor's memory-import turn; tests set their own. */
export const importPorts = (hub: Hub): { turn: Turn } => hub.area("memory_import", (h) => ({ turn: turn(h, Owner.MemoryImport) }));

/** The export prompt every app shows, as the hub's prompts say it now. */
export const exportPrompt = (hub: Hub) => prompts(hub.db).current().render("memory.export", {});

/**
 * Where the turn runs: any live project of the hub, the first on a node that can hold the turn to no tools.
 * Refused on a hub with none, and while none is on such a node.
 */
function place(hub: Hub): ProjectRef {
  const live = store(hub)
    .projectsShown()
    .filter((p) => p.archivedAt === undefined)
    .map((p) => ({ machineId: p.machineId, projectId: p.projectId }));
  const first = live[0];
  if (!first) {
    throw new ToolError(
      "invalid",
      "Import memory runs in one of this hub's projects, and it has none yet. Everyone on this hub can read what it writes.",
      NO_PROJECT_FIX,
      "no_project",
    );
  }
  const ports = refreshPorts(hub);
  const found = live.find((r) => ports.can(r.machineId, CAP_ALLOWED_ONLY));
  if (!found) {
    throw new ToolError(
      "machine_offline",
      `The projects' machine, ${first.machineId}, is offline or runs a fleetd too old for this.`,
      `Bring ${first.machineId} online with an up-to-date fleetd, then try again.`,
    );
  }
  return found;
}

/** The turn's rules, and its message: the person's memory now and the export between two fences no paste can fake. */
export function importPrompts(hub: Hub, memory: string, text: string): [string, string] {
  const fence = importFence();
  const rules = prompts(hub.db).current().render("memory.import", { fence });
  return [rules, importMessage(memory, text, fence)];
}

/** The person's import of `text`: the turn, then its entries written to their memory. */
export async function importMemory(hub: Hub, you: You, by: string, text: string, using: Turn = importPorts(hub).turn): Promise<MemoryImportOutput> {
  const memory = Memory.of(hub);
  const t = youTarget(you);
  if (!t) {
    throw new ToolError(
      "forbidden",
      "Imported memory goes into a person's own memory, and this key belongs to no person.",
      "Import from your own device (a human key from an invite or `fleetd pair`).",
    );
  }
  const person = t.person;
  const r = place(hub);
  const setup = new ClaudeAccountStore(hub.db).setup();
  const ports = refreshPorts(hub);
  const account = launchAccount(setup, person === undefined ? { hub: true } : { person }, r.machineId, () =>
    ports.can(r.machineId, CAP_CLAUDE_ACCOUNTS) ? "runs" : ports.lacks(r.machineId, CAP_CLAUDE_ACCOUNTS) ? "too_old" : "offline",
  );
  if (isRefusal(account)) throw new ToolError("invalid", account.message, account.fix);
  const [systemPrompt, prompt] = importPrompts(hub, memory.read(t), text);
  let profile = "legacy";
  try {
    profile = profiles(hub).defaultProfile().name;
  } catch {}
  const input: LaunchInput = {
    projectId: r.projectId,
    prompt,
    systemPrompt,
    profile,
    // Its node asks for any tool, and refuses it: it has none.
    runtimeMode: "approval-required",
    title: "fleetd memory import",
    clientRequestId: `fleetd-memory-import:${person ?? "shared"}:${fenceNonce()}`,
  };
  const options: LaunchOptions = {
    role: "plain",
    mcp: { userServers: false, servers: [] },
    onlyTools: [],
    ...(account === undefined ? {} : { claudeAccount: account }),
  };
  let reply: string;
  try {
    reply = await using.run(r, person, input, options);
  } catch (error) {
    throw new ToolError("failed", `The import didn't finish: ${(error as Error).message}.`, "Try again; nothing was added.");
  }
  const entries = parse(reply);
  if (!entries) throw new ToolError("failed", "The model's answer couldn't be read as memory entries. Nothing was added.", "Try again.");
  const [added, skipped] = write(hub, r, person, entries);
  if (added.length > 0) changed(hub, undefined, undefined, by);
  const now = memory.read(t);
  const cap = memory.cap(t);
  const full = skipped.filter((s) => s.why === "full").length;
  const next =
    added.length === 0 && full === 0
      ? "Nothing new to add: your memory already says it all."
      : full === 0
        ? `Added ${added.length} to your memory.`
        : `Added ${added.length} to your memory; ${full} more didn't fit under its cap of ${cap} characters (skipped, why full). Trim your memory, then import again to add them.`;
  return { prompt: exportPrompt(hub), added, skipped, chars: [...now].length, cap, next };
}

/** Writes `entries` to the person's own memory as `remember` writes them, the more lasting kinds first. */
function write(hub: Hub, r: ProjectRef, person: PersonId | undefined, entries: Distilled[]): [MemoryImported[], MemorySkipped[]] {
  const sorted = entries.map((e, i) => [e, i] as const).sort((a, b) => rank(a[0].kind) - rank(b[0].kind) || a[1] - b[1]);
  const memory = Memory.of(hub);
  const t = userTarget(person);
  const added: MemoryImported[] = [];
  const skipped: MemorySkipped[] = [];
  const seen: string[] = [];
  const skip = (text: string, why: MemoryImportSkip) => {
    if (entryOk(text)) skipped.push({ text, why });
  };
  for (const [e] of sorted) {
    if (added.length >= IMPORT_ENTRIES_MAX) break;
    const text = clean(e.text);
    if (!text || seen.includes(same(text))) continue;
    seen.push(same(text));
    const redacted = redact(text);
    if (redacted !== text) {
      skip(redacted, "secret");
      continue;
    }
    if (memory.read(t).split("\n").some((l) => same(l) === same(text))) {
      skip(text, "duplicate");
      continue;
    }
    if (!entryOk(text)) continue;
    const old = e.replaces === undefined ? undefined : clean(e.replaces);
    const call: RememberCall = { scope: "user", text, ...(old && entryOk(old) ? { replaces: old } : {}) };
    let wrote: ReturnType<Memory["remember"]> | ToolError;
    const attempt = (c: RememberCall) => {
      try {
        return memory.remember(r, person, c);
      } catch (error) {
        if (error instanceof ToolError) return error;
        throw error;
      }
    };
    wrote = attempt(call);
    // The entry it names isn't there as quoted: it goes in as a new one.
    if (wrote instanceof ToolError && call.replaces !== undefined) {
      const { replaces: _, ...plain } = call;
      wrote = attempt(plain);
    }
    if (wrote instanceof ToolError) {
      if (wrote.code === "invalid") {
        skip(text, "full");
        continue;
      }
      throw wrote;
    }
    if (wrote.item) added.push({ text: wrote.item.text, ...(wrote.item.replaced === undefined ? {} : { replaced: wrote.item.replaced }) });
    else skip(text, "duplicate");
  }
  return [added, skipped.slice(0, IMPORT_ENTRIES_MAX)];
}

/**
 * memory_import and memory_refresh_run (memory/tools.rs): Import memory, a person's own, and Run now on the nightly
 * refresh's row in Settings > Automations.
 */
export function registerImportAndRefresh(tools: Registry): void {
  tools.add("memory_import", async (hub, caller, input) => {
    requireHuman(caller, "memory_import");
    const text = input.text ?? "";
    // The caller's own memory: their person's; the shared user.md on a hub with no people; nobody's for a key with none.
    const you: You = caller.person ? { kind: "person", person: caller.person.personId } : activePeople(hub.db).length === 0 ? { kind: "shared" } : { kind: "nobody" };
    if (!text.trim()) {
      const memory = Memory.of(hub);
      const t = youTarget(you);
      return {
        prompt: exportPrompt(hub),
        added: [],
        skipped: [],
        chars: t ? [...memory.read(t)].length : 0,
        cap: t ? memory.cap(t) : memory.caps.user,
        next: "Copy the prompt into your other assistant, then call again with its answer as text.",
      };
    }
    return importMemory(hub, you, caller.name, text);
  });

  tools.add("memory_refresh_run", async (hub, caller, input) => {
    const r = input.projectRef;
    requireRole(caller, "operate", r.machineId);
    if (!store(hub).projectGet(r)) throw unknownProject(r);
    const why = await runNow(hub, r);
    return {
      memoryRefresh: job(hub, r),
      ...(why === undefined ? {} : { why }),
      next:
        why === undefined
          ? "Refreshing: a line in the chat lists what it changed, with Undo; nothing changed posts nothing."
          : "Nothing started; the nightly pass goes on as before.",
    };
  });
}
