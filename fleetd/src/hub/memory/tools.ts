// memory_get, memory_set, memory_undo and memory_hold_answer: Settings > Memory, the chat's Undo, and an admin's Keep
// or Don't keep on a bot memory line held for their OK (hold_rules.ts).
// Writes are a person's (human keys): an agent changes memory only through its lead's `remember` and `forget`. Each
// person's own memory is theirs alone, admins included, except to delete a removed person's. The caps are an admin's;
// the shared user.md of before people is read and edited as Your memory only on a hub with no people yet.
import type { ChatMessage, MemoryFile, MemoryRefreshed, PersonId, ProjectRef, RememberedItem, Role } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { allows } from "../auth/index.ts";
import type { Hub } from "../api/hub.ts";
import { isHuman, requireRole } from "../api/grants.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { chat } from "../chat/index.ts";
import { requireHuman, unknownProject } from "../leads/seams.ts";
import { store } from "../store/hub_store.ts";
import { settingsPath } from "../../shared/settings_path.ts";
import { mayChangeBot } from "../api/bot_admin.ts";
import { nowMs } from "../store/time.ts";
import { changed, hold } from "./calls.ts";
import { changeLoosens, holdsForAdmin, namesGate } from "./hold_rules.ts";
import { activePeople, isIndexLine, linesOf, Memory, projectTarget, type Target, type You, youTarget, userTarget } from "./index.ts";
import { anyAdmin, authors, held, isAdmin, personRef, taught } from "./lines.ts";
import { registerImportAndRefresh } from "./import.ts";
import { lineItems, listed, putLineItems } from "./refresh_store.ts";
import { lastTidied, pageLine, setPageLine } from "./tidy.ts";
import { sameSnapshot } from "./tidy_rules.ts";
import { getTidy, lineSnapshot } from "./tidy_store.ts";

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
  throw new ToolError("forbidden", "That entry is in the shared memory, which only the workspace's owners and admins edit now.");
}

/**
 * Undo on a "Memory refreshed" line: the change at `index`, or every change not yet undone, newest first. Each one
 * undone is marked, even when a later one can't be: that one says why. Undo all of a tidy's line whose person's memory
 * is still as the tidy left it puts it back exactly as the tidy found it.
 */
function undoRefreshed(
  hub: Hub,
  caller: Caller,
  message: ChatMessage,
  refreshed: MemoryRefreshed,
  index: number | undefined,
  // The line as its chat (or the Memory page, for a tidy's own line) shows it, marked.
  shown: (refreshed: MemoryRefreshed) => void = (now) => chat(hub).setMemoryRefreshed(message, now),
) {
  const r = message.projectRef;
  const id = message.messageId;
  const items = lineItems(hub.db, id) ?? refreshed.items.map((i) => ({ ...i }));
  const snapshot = index === undefined ? lineSnapshot(hub.db, id) : undefined;
  if (snapshot && items.every((i) => i.undone !== true)) {
    const memory = Memory.of(hub);
    if (sameSnapshot(memory.snapshot(snapshot.person), snapshot.after)) {
      if (caller.person?.personId !== snapshot.person) throw theirs(hub, snapshot.person);
      memory.restore(snapshot.person, snapshot.before);
      changed(hub, undefined, undefined, caller.name);
      const undone = items.map((i) => ({ ...i, undone: true }));
      putLineItems(hub.db, r, id, undone);
      shown(listed(undone));
      return { ok: true as const };
    }
  }
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
    shown(listed(items));
  }
  if (failed !== undefined) throw failed;
  return { ok: true as const, ...(done === 0 ? { next: "Already undone." } : {}) };
}

/**
 * A person's edit of a bot's memory file: each line it adds is theirs (lines.ts). From someone who isn't an owner or
 * admin, a line added that loosens what asks or merges is left out and held, and one taken out that names a gate is
 * kept and its removal held (hold_rules.ts): `text` is what to write, `holds` the changes that wait.
 */
function projectEdit(hub: Hub, caller: Caller, memory: Memory, t: Target, edited: string): { text: string; holds: RememberedItem[] } {
  const r = t.project as ProjectRef;
  // Every line but a blank or a topic's is an entry, written with "- " or without.
  const entryOf = (line: string) => {
    const l = line.trimEnd();
    return l.trim() === "" || isIndexLine(l) ? undefined : l.replace(/^(- )+/, "");
  };
  const entries = (text: string) => linesOf(text).flatMap((l) => entryOf(l) ?? []);
  const before = new Set(entries(memory.read(t)));
  const after = new Set(entries(edited));
  const person = caller.person?.personId;
  const holding = !isAdmin(hub.db, person) && anyAdmin(hub.db);
  const topic = t.topic === undefined ? {} : { topic: t.topic };
  const holds: RememberedItem[] = [];
  const out: string[] = [];
  for (const line of linesOf(edited)) {
    const entry = entryOf(line);
    if (entry !== undefined && !before.has(entry)) {
      if (holding && holdsForAdmin(changeLoosens(entry, undefined, undefined), false, true)) {
        holds.push({ scope: "project", ...topic, text: entry });
        continue;
      }
      taught(hub.db, r, t.topic, entry, person, nowMs(hub.clock));
    }
    out.push(line);
  }
  if (holding) {
    for (const entry of before) {
      if (after.has(entry) || !namesGate(entry)) continue;
      holds.push({ scope: "project", ...topic, text: entry, forgotten: true });
      // Kept where an index line would follow it: above the topics, as `remember` puts entries.
      const i = out.findIndex((l) => isIndexLine(l.trimEnd()));
      out.splice(i < 0 ? out.length : i, 0, `- ${entry}`);
    }
  }
  return { text: out.length === 0 ? "" : `${out.join("\n")}\n`, holds };
}

export function register(tools: Registry): void {
  registerImportAndRefresh(tools);
  tools.add("memory_get", (hub, caller, input) => {
    const memory = Memory.of(hub);
    const own = youTarget(mine(hub, caller));
    const user: MemoryFile = own ? memory.file(own) : { scope: "user", text: "", chars: 0, cap: memory.caps.user, notes: [] };
    const userFiles = own ? memory.topicsOf(own).map((topic) => memory.file(userTarget(own.person, topic))) : [];
    const tidied = own?.person === undefined ? undefined : lastTidied(hub, own.person);
    const tidyRun = own?.person === undefined ? undefined : getTidy(hub.db, own.person).lastRun;
    const yours = { user, ...(userFiles.length ? { userFiles } : {}), ...(tidied ? { tidied } : {}), ...(tidyRun ? { tidyRun } : {}) };
    const r = input.projectRef;
    if (!r) {
      return { ...yours, caps: memory.caps, next: "memory_get with projectRef adds that bot's MEMORY.md and topic files." };
    }
    knownProject(hub, caller, r, "read");
    const files = [undefined, ...memory.topics(r)].map((topic) => {
      const file = memory.file(projectTarget(r, topic));
      const taughtBy = authors(hub.db, r, topic, file.text);
      return taughtBy.length > 0 ? { ...file, authors: taughtBy } : file;
    });
    const waiting = held(hub, r);
    return {
      ...yours,
      files,
      ...(waiting.length > 0 ? { held: waiting } : {}),
      projectChars: memory.projectChars(r),
      projectCap: memory.caps.project,
      caps: memory.caps,
    };
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
    if (!project && input.topic === "user") {
      throw new ToolError("invalid", "user.md is the core of your memory; name the topic something else.");
    }
    const own = youTarget(you);
    let t: Target | undefined = project ? projectTarget(project, input.topic) : own && userTarget(own.person, input.topic);
    if (!t) {
      throw new ToolError(
        "forbidden",
        "User memory is a person's own, and this key belongs to no person.",
        "Edit it from your own device (a human key from an invite or `fleetd pair`).",
      );
    }
    const memory = Memory.of(hub);
    if (project) {
      const { text, holds } = projectEdit(hub, caller, memory, t, input.text);
      memory.set(t, text);
      changed(hub, project, input.topic, caller.name);
      for (const item of holds) hold(hub, project, item, caller.person);
      const file = memory.file(t);
      const taughtBy = authors(hub.db, project, input.topic, file.text);
      return {
        file: taughtBy.length > 0 ? { ...file, authors: taughtBy } : file,
        ...(holds.length > 0 ? { next: `${holds.length === 1 ? "A change waits" : `${holds.length} changes wait`} for an admin's OK; the rest is saved.` } : {}),
      };
    }
    memory.set(t, input.text);
    changed(hub, project, input.topic, caller.name);
    t = t as Target;
    return { file: Memory.of(hub).file(t) };
  });

  tools.add("memory_hold_answer", (hub, caller, input) => {
    requireHuman(caller, "memory_hold_answer");
    const r = input.projectRef;
    knownProject(hub, caller, r, "operate");
    if (!mayChangeBot(hub, caller, r.machineId)) {
      throw new ToolError("forbidden", "Only the workspace's owners and admins keep a held memory line.", `Ask one of them, or to make you an admin in ${settingsPath("People")}.`);
    }
    const message = chat(hub).byId(input.messageId);
    const item = message?.remembered;
    if (!message || !item || message.projectRef.machineId !== r.machineId || message.projectRef.projectId !== r.projectId || item.hold === undefined) {
      throw new ToolError("not_found", "That memory line isn't waiting in this bot.");
    }
    if (item.hold !== "waiting") return { ok: true, next: item.hold === "kept" ? "Already kept." : "Already answered: not kept." };
    const name = (caller.person && personRef(hub.db, caller.person.personId)?.name) ?? caller.name;
    const topic = item.topic === undefined ? {} : { topic: item.topic };
    if (!input.keep) {
      chat(hub).setRemembered(message, { ...item, hold: "dropped" }, `Not kept by ${name}: ${item.text}`);
      return { ok: true };
    }
    const memory = Memory.of(hub);
    if (item.forgotten === true) {
      memory.forget(r, undefined, { scope: "project", ...topic, entry: item.text });
    } else {
      // The entry it was to replace may have gone since: then it is added.
      const still = item.replaced !== undefined && linesOf(memory.read(projectTarget(r, item.topic))).some((l) => l.trimEnd() === `- ${item.replaced}`);
      memory.remember(r, undefined, { scope: "project", ...topic, text: item.text, ...(still ? { replaces: item.replaced } : {}) });
      taught(hub.db, r, item.topic, item.text, item.by?.personId, nowMs(hub.clock));
    }
    changed(hub, r, item.topic, caller.name);
    const said = item.forgotten === true ? `Forgot, kept by ${name}: ${item.text}` : `Remembered, kept by ${name}: ${item.text}`;
    chat(hub).setRemembered(message, { ...item, hold: "kept" }, said);
    return { ok: true };
  });

  tools.add("memory_undo", (hub, caller, input) => {
    requireHuman(caller, "memory_undo");
    // A tidy's line only its person's Memory page shows: theirs to undo, whatever their grants on its machine.
    const page = pageLine(hub, input.messageId);
    if (page) {
      if (caller.person?.personId !== page.person) throw theirs(hub, page.person);
      const { line, person } = page;
      return undoRefreshed(hub, caller, line, line.memoryRefreshed as MemoryRefreshed, input.item, (now) =>
        setPageLine(hub, person, { ...line, memoryRefreshed: now }),
      );
    }
    const r = input.projectRef;
    requireRole(caller, "operate", r.machineId);
    const notFound = () => new ToolError("not_found", `No remembered line ${input.messageId} in this chat.`);
    const message = chat(hub).byId(input.messageId);
    if (!message || message.projectRef.machineId !== r.machineId || message.projectRef.projectId !== r.projectId) throw notFound();
    if (message.memoryRefreshed) return undoRefreshed(hub, caller, message, message.memoryRefreshed, input.item);
    const item = message.remembered;
    if (!item) throw notFound();
    if (item.undone === true) return { ok: true, next: "Already undone." };
    // A held line isn't in memory: its Undo only takes the ask back.
    if (item.hold === "waiting") {
      chat(hub).setRemembered(message, { ...item, hold: "dropped", undone: true });
      return { ok: true };
    }
    if (item.hold === "dropped") return { ok: true, next: "It was never kept." };
    mayUndo(hub, caller, item);
    Memory.of(hub).undo(r, item);
    changed(hub, item.scope === "project" ? r : undefined, item.topic, caller.name);
    chat(hub).setRemembered(message, { ...item, undone: true });
    return { ok: true };
  });
}

