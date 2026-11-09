// memory_get, memory_set and memory_undo: Settings > Memory and the chat's Undo.
// Writes are a person's (human keys): an agent changes memory only through its lead's `remember` and `forget`. Each
// person's own memory is theirs alone, admins included, except to delete a removed person's. The caps, and
// memory_shared_get and memory_shared_set (the shared user.md of before people), are an admin's.
import type { ChatMessage, MemoryFile, MemoryRefreshed, PersonId, ProjectRef, RememberedItem, Role } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { allows } from "../auth/index.ts";
import type { Hub } from "../api/hub.ts";
import { isHuman, REPAIR_FIX, requireRole } from "../api/grants.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { chat } from "../chat/index.ts";
import { requireHuman, unknownProject } from "../leads/seams.ts";
import { store } from "../store/hub_store.ts";
import { changed } from "./calls.ts";
import { activePeople, Memory, projectTarget, type Target, type You, youTarget, userTarget } from "./index.ts";
import { registerImportAndRefresh } from "./import.ts";
import { lineItems, listed, putLineItems } from "./refresh_store.ts";

/** The caller's own memory: their person's; the shared user.md on a hub with no people; nobody's for a key with none. */
function mine(hub: Hub, caller: Caller): You {
  if (caller.person) return { kind: "person", person: caller.person.personId };
  return activePeople(hub.db).length === 0 ? { kind: "shared" } : { kind: "nobody" };
}

function knownProject(hub: Hub, caller: Caller, r: ProjectRef, role: Role): void {
  requireRole(caller, role, r.machineId);
  if (!store(hub).projectGet(r)) throw unknownProject(r);
}

const allowsEverywhere = (caller: Caller, role: Role) => caller.grants.some((g) => g.machines === "*" && allows({ ...caller, grants: [g] }, role));


type PersonRow = { name: string; role: string; removed_ms: number | null };

const personOf = (hub: Hub, p: PersonId) =>
  hub.db.all<PersonRow>("SELECT name, role, removed_ms FROM people WHERE person_id = ?", [p])[0];

function theirs(hub: Hub, p: PersonId): ToolError {
  const name = personOf(hub, p)?.name || p;
  return new ToolError("forbidden", `${name}'s memory is theirs: only they read and edit it.`);
}

/** An owner's or admin's device with admin on every machine (people/tools.rs `administrator`). */
function administrator(hub: Hub, caller: Caller): boolean {
  if (!caller.person || !isHuman(caller)) return false;
  const role = personOf(hub, caller.person.personId)?.role;
  return (role === "owner" || role === "admin") && allowsEverywhere(caller, "admin");
}

/** Another person's memory is edited by nobody: an owner or admin only deletes it once they are removed. */
function removedPersons(hub: Hub, caller: Caller, p: PersonId, text: string): void {
  const removed = personOf(hub, p)?.removed_ms != null;
  if (removed && !text.trim() && administrator(hub, caller)) return;
  const refusal = theirs(hub, p);
  throw new ToolError(
    refusal.code,
    refusal.message,
    "Edit your own (memory_set without personId). An owner or admin may delete a removed person's memory, with empty text.",
  );
}

/** Only its person undoes an entry of their own memory; one of the shared user.md is an admin's, once the hub has people. */
function mayUndo(hub: Hub, caller: Caller, item: RememberedItem): void {
  if (item.scope === "project") return;
  const me = caller.person?.personId;
  if (item.person !== undefined) {
    if (item.person === me) return;
    throw theirs(hub, item.person);
  }
  if (mine(hub, caller).kind === "shared" || allowsEverywhere(caller, "admin")) return;
  throw new ToolError("forbidden", "That entry is in the shared memory, which only the hub's owners and admins edit now.");
}

/** The shared user.md is every project's of before people: Admin on every machine reads and edits it. */
function requireHubAdmin(caller: Caller): void {
  if (!allowsEverywhere(caller, "admin")) {
    throw new ToolError(
      "forbidden",
      "The shared memory is hub-wide: it needs Admin on every machine.",
      isHuman(caller) ? REPAIR_FIX : "Use an Admin key for all machines (`--machines '*'`).",
    );
  }
}

/**
 * Undo on a "Memory refreshed" line: the change at `index`, or every change not yet undone, newest first. Each one
 * undone is marked, even when a later one can't be: that one says why.
 */
function undoRefreshed(hub: Hub, caller: Caller, message: ChatMessage, refreshed: MemoryRefreshed, index: number | undefined) {
  const r = message.projectRef;
  const id = message.messageId;
  const items = lineItems(hub.db, id) ?? refreshed.items.map((i) => ({ ...i }));
  let picked: number[];
  if (index !== undefined) {
    if (index >= items.length) throw new ToolError("not_found", `That line has ${items.length} changes, not a change ${index}.`);
    mayUndo(hub, caller, items[index] as RememberedItem);
    picked = [index];
  } else picked = items.map((_, i) => i).reverse();
  const memory = Memory.of(hub);
  let failed: unknown;
  let done = 0;
  for (const i of picked) {
    const item = items[i] as RememberedItem;
    let allowed = true;
    try {
      mayUndo(hub, caller, item);
    } catch {
      allowed = false;
    }
    // Undo all leaves another person's memory alone.
    if (item.undone === true || !allowed) continue;
    try {
      memory.undo(r, item);
    } catch (error) {
      failed = error;
      break;
    }
    changed(hub, item.scope === "project" ? r : undefined, item.topic, caller.name);
    items[i] = { ...item, undone: true };
    done += 1;
  }
  if (done > 0) {
    putLineItems(hub.db, r, id, items);
    chat(hub).setMemoryRefreshed(message, listed(items));
  }
  if (failed !== undefined) throw failed;
  return { ok: true as const, ...(done === 0 ? { next: "Already undone." } : {}) };
}

export function register(tools: Registry): void {
  registerImportAndRefresh(tools);
  tools.add("memory_get", (hub, caller, input) => {
    const memory = Memory.of(hub);
    const own = youTarget(mine(hub, caller));
    const user: MemoryFile = own ? memory.file(own) : { scope: "user", text: "", chars: 0, cap: memory.caps.user, notes: [] };
    const r = input.projectRef;
    if (!r) {
      return { user, caps: memory.caps, next: "memory_get with projectRef adds that project's MEMORY.md and topic files." };
    }
    knownProject(hub, caller, r, "read");
    const files = [memory.file(projectTarget(r)), ...memory.topics(r).map((t) => memory.file(projectTarget(r, t)))];
    return { user, files, projectChars: memory.projectChars(r), projectCap: memory.caps.project, caps: memory.caps };
  });

  tools.add("memory_set", (hub, caller, input) => {
    requireHuman(caller, "memory_set");
    let project: ProjectRef | undefined;
    if (input.scope === "project" && input.projectRef) {
      knownProject(hub, caller, input.projectRef, "operate");
      project = input.projectRef;
    }
    const me = caller.person?.personId;
    let you: You;
    if (input.personId !== undefined && input.personId !== me) {
      removedPersons(hub, caller, input.personId, input.text);
      you = { kind: "person", person: input.personId };
    } else you = mine(hub, caller);
    let t: Target | undefined = project ? projectTarget(project, input.topic) : youTarget(you);
    if (!t) {
      throw new ToolError(
        "forbidden",
        "User memory is a person's own, and this key belongs to no person.",
        "Edit it from your own device (a human key from an invite or `fleetd pair`).",
      );
    }
    const memory = Memory.of(hub);
    memory.set(t, input.text);
    changed(hub, project, input.topic, caller.name);
    t = t as Target;
    return { file: Memory.of(hub).file(t) };
  });

  tools.add("memory_undo", (hub, caller, input) => {
    requireHuman(caller, "memory_undo");
    const r = input.projectRef;
    requireRole(caller, "operate", r.machineId);
    const notFound = () => new ToolError("not_found", `No remembered line ${input.messageId} in this chat.`);
    const message = chat(hub).byId(input.messageId);
    if (!message || message.projectRef.machineId !== r.machineId || message.projectRef.projectId !== r.projectId) throw notFound();
    if (message.memoryRefreshed) return undoRefreshed(hub, caller, message, message.memoryRefreshed, input.item);
    const item = message.remembered;
    if (!item) throw notFound();
    if (item.undone === true) return { ok: true, next: "Already undone." };
    mayUndo(hub, caller, item);
    Memory.of(hub).undo(r, item);
    changed(hub, item.scope === "project" ? r : undefined, item.topic, caller.name);
    chat(hub).setRemembered(message, { ...item, undone: true });
    return { ok: true };
  });

  tools.add("memory_shared_get", (hub, caller) => {
    requireHubAdmin(caller);
    return {
      file: Memory.of(hub).file(userTarget()),
      next: "No session reads it: each person has their own memory, and the hub's owner got a copy. Empty it with memory_shared_set to retire it.",
    };
  });

  tools.add("memory_shared_set", (hub, caller, input) => {
    requireHuman(caller, "memory_shared_set");
    requireHubAdmin(caller);
    const t = userTarget();
    Memory.of(hub).set(t, input.text);
    changed(hub, undefined, undefined, caller.name);
    return { file: Memory.of(hub).file(t) };
  });
}

