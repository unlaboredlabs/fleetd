// The lead's `remember`, `forget` and `memory_read`, scoped to the caller's project by its session.
// User scope is a person's own memory: the one whose message the turn answers
// (a project's owner), and refused when that is nobody; a tidy's, the person it tidies. A nightly refresh's or tidy's
// changes are kept for its one line at the end. A bot's line records who taught it (lines.ts), and one that loosens what
// asks or merges, taught by someone who isn't an admin, waits for an admin's OK instead (hold_rules.ts); the nightly
// refresh's, only when it adds a loosening the lines it rewrites didn't have.
import type { MemoryScope, PersonId, PersonRef, ProjectRef, RememberedItem } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { aboutFor } from "../chat/about.ts";
import { state } from "../chat/flow.ts";
import { chat } from "../chat/index.ts";
import { LeadRecords } from "../leads/records.ts";
import { runHuman } from "../leads/requested.ts";
import { type LeadCall, type LeadCaller, leadCalls } from "../leads/seams.ts";
import { events } from "../store/events.ts";
import { isoMs, nowMs } from "../store/time.ts";
import { FILE_CAP_MAX, type ForgetCall, INDEX_FILE, isTopic, Memory, nameOf, projectTarget, type RememberCall, userTarget, type You, youOf } from "./index.ts";
import { changeLoosens, holdsForAdmin, MEMORY_EFFECTS, type MemoryEffect, upkeepLoosens } from "./hold_rules.ts";
import { anyAdmin, heldLines, isAdmin, taught } from "./lines.ts";
import { getRun, record, refreshYou } from "./refresh_store.ts";
import { recordTidy } from "./tidy_store.ts";

export const OPS = ["remember", "forget", "memory_read"] as const;

export function registerLeadCalls(hub: Hub): void {
  for (const op of OPS) leadCalls(hub).register(op, (caller, call) => answer(hub, caller, call));
}

const invalid = (why: string) => new ToolError("invalid", `Invalid ${why}.`);

function scopeOf(call: LeadCall): MemoryScope {
  if (call.scope !== "user" && call.scope !== "project") throw invalid(`${call.op} call: scope is user or project`);
  topicOk(call.op, call.scope, call.topic);
  return call.scope;
}

/** A topic, when the call names one: a slug, other than `memory`, and in user scope other than `user` (its core). */
function topicOk(op: string, scope: MemoryScope, topic: unknown): void {
  if (topic === undefined) return;
  if (typeof topic !== "string" || !isTopic(topic)) throw invalid(`${op} call: topic is a lowercase slug, [a-z0-9][a-z0-9-]{0,47}, other than memory`);
  if (scope === "user" && topic === "user") throw invalid(`${op} call: user.md is the core of user memory; name the topic something else`);
}

const lineOf = (max: number) => (s: unknown): s is string => typeof s === "string" && s.length >= 1 && s.length <= max && !/[\r\n]/.test(s);
/** Words quoted from an entry (`replaces`, `entry`): enough to match one. */
const entryOk = lineOf(1000);
/** An entry's own text: one line, as long as a file may be (no cap per entry). */
const textOk = lineOf(FILE_CAP_MAX);

/** A lead's `remember` or `forget` in user scope: that of the person whose message the turn answers. */
export function youForTurn(hub: Hub, r: ProjectRef, now: number): You {
  const lead = new LeadRecords(hub.db).leadGet(r);
  const person = lead ? runHuman(hub.db, r, lead.threadId, now)?.person : undefined;
  return youOf(hub.db, person?.personId);
}

/** Whose memory a call of `scope` writes: in user scope the person behind the turn; refused when that is nobody. */
function whose(hub: Hub, caller: LeadCaller, scope: MemoryScope): PersonId | undefined {
  if (scope === "project") return undefined;
  const r = caller.projectRef;
  if (caller.agent.kind === "memory_refresh" && caller.agent.person !== undefined) return caller.agent.person;
  const refresh = caller.agent.kind === "memory_refresh";
  const you = refresh ? refreshYou(hub.db, r) : youForTurn(hub, r, nowMs(hub.clock));
  if (you.kind === "person") return you.person;
  if (you.kind === "shared") return undefined;
  throw new ToolError(
    "invalid",
    "User memory is each person's own, and no one person's message is behind this turn.",
    refresh
      ? "Several people wrote in this chat: leave user memory as it is tonight."
      : "Remember it in project scope, or in user scope when that person writes to you.",
  );
}

export function answer(hub: Hub, caller: LeadCaller, call: LeadCall): Record<string, unknown> {
  const r = caller.projectRef;
  const memory = Memory.of(hub, caller.agent.kind === "memory_refresh" ? caller.agent.person : undefined);
  if (call.op === "remember") {
    const scope = scopeOf(call);
    if (!textOk(call.text)) throw invalid(`remember call: text is one line of 1 to ${FILE_CAP_MAX} characters`);
    if (call.replaces !== undefined && !entryOk(call.replaces)) throw invalid("remember call: replaces is one line of 1 to 1000 characters");
    const remember: RememberCall = {
      scope,
      text: call.text,
      ...(call.topic === undefined ? {} : { topic: call.topic as string }),
      ...(call.replaces === undefined ? {} : { replaces: call.replaces as string }),
    };
    if (scope === "project") {
      if (!MEMORY_EFFECTS.includes(call.effect as MemoryEffect)) {
        throw new ToolError(
          "invalid",
          "Invalid remember call: in project scope, effect says what the line does: loosens or none.",
          "loosens: it makes this bot ask less before acting, or merge or deploy with less review. Else none.",
        );
      }
      if (call.own !== undefined && typeof call.own !== "boolean") throw invalid("remember call: own is true or false");
      const taughtBy = teacher(hub, caller);
      const { already, replaced } = memory.wouldRemember(r, undefined, remember);
      if (already) return { file: nameOf(projectTarget(r, remember.topic)), next: "Already remembered, word for word." };
      const loosening = upkeep(caller)
        ? upkeepLoosens(call.text, call.effect as MemoryEffect, replaced)
        : changeLoosens(call.text, call.effect as MemoryEffect, replaced);
      if (holdsForAdmin(loosening, isAdmin(hub.db, taughtBy?.personId), anyAdmin(hub.db))) {
        return hold(hub, r, { scope: "project", ...topicOf(remember.topic), text: call.text, ...(replaced === undefined ? {} : { replaced }) }, taughtBy);
      }
      const { target, item, chars } = memory.remember(r, undefined, remember);
      let next = "Already remembered, word for word.";
      if (item) {
        const by = call.own === true ? undefined : taughtBy;
        taught(hub.db, r, call.topic as string | undefined, call.text, by?.personId, nowMs(hub.clock));
        remembered(hub, r, caller, { ...item, ...(by ? { by } : {}) });
        next = `Remembered in ${nameOf(target)}. Sessions get it from their next start; you already know it.`;
      }
      return { file: nameOf(target), chars, cap: memory.cap(target), next };
    }
    const { target, item, chars } = memory.remember(r, whose(hub, caller, scope), remember);
    let next = "Already remembered, word for word.";
    if (item) {
      remembered(hub, r, caller, item);
      next = `Remembered in ${nameOf(target)}. Sessions get it from their next start; you already know it.`;
    }
    return { file: nameOf(target), chars, cap: memory.cap(target), next };
  }
  if (call.op === "forget") {
    const scope = scopeOf(call);
    if (!entryOk(call.entry)) throw invalid("forget call: entry is one line of 1 to 1000 characters");
    const forget: ForgetCall = {
      scope,
      entry: call.entry,
      ...(call.topic === undefined ? {} : { topic: call.topic as string }),
      ...(typeof call.reason === "string" ? { reason: call.reason } : {}),
    };
    if (scope === "project") {
      const taughtBy = teacher(hub, caller);
      const whole = memory.entryOf(projectTarget(r, forget.topic), forget.entry);
      const loosening = upkeep(caller) ? upkeepLoosens(undefined, undefined, whole, writtenTonight(hub, r)) : changeLoosens(undefined, undefined, whole);
      if (holdsForAdmin(loosening, isAdmin(hub.db, taughtBy?.personId), anyAdmin(hub.db))) {
        return hold(hub, r, { scope: "project", ...topicOf(forget.topic), text: whole, forgotten: true, ...(forget.reason === undefined ? {} : { reason: forget.reason }) }, taughtBy);
      }
    }
    const { target, item, chars } = memory.forget(r, whose(hub, caller, scope), forget);
    remembered(hub, r, caller, item);
    return {
      file: nameOf(target),
      chars,
      cap: memory.cap(target),
      next: `Forgot it from ${nameOf(target)}. Sessions go without it from their next start.`,
    };
  }
  if (call.op === "memory_read") {
    const scope = call.scope === undefined ? "project" : scopeOf(call);
    if (typeof call.topic !== "string") throw invalid("memory_read call: topic is a lowercase slug, [a-z0-9][a-z0-9-]{0,47}, other than memory");
    topicOk(call.op, scope, call.topic);
    const t = scope === "user" ? userTarget(whose(hub, caller, scope), call.topic) : projectTarget(r, call.topic);
    const text = memory.read(t);
    const core = scope === "user" ? "user.md" : INDEX_FILE;
    return {
      topic: call.topic,
      text,
      ...(text.trim() ? {} : { next: `There is no topic ${call.topic} yet; ${core} lists the ones there are.` }),
    };
  }
  throw new ToolError("invalid", `${call.op} is not a memory call.`);
}

/** Who teaches a lead's line: the person its turn is for (its order's starter, else whose message it answers); none for a nightly refresh. */
function teacher(hub: Hub, caller: LeadCaller): PersonRef | undefined {
  if (caller.agent.kind === "memory_refresh") return undefined;
  return aboutFor(hub, caller.projectRef, nowMs(hub.clock)).for;
}

/** The nightly upkeep of a bot's memory, whose rewrites and merges hold only for what they add (hold_rules.ts `upkeepLoosens`). */
const upkeep = (caller: LeadCaller) => caller.agent.kind === "memory_refresh" && caller.agent.person === undefined;

/** The bot memory lines the running upkeep of `r` wrote so far: a line it takes out may carry its gates into one. */
const writtenTonight = (hub: Hub, r: ProjectRef) =>
  getRun(hub.db, r).items.flatMap((i) => (i.scope === "project" && i.forgotten !== true && i.undone !== true ? [i.text] : []));

const topicOf = (topic: string | undefined) => (topic === undefined ? {} : { topic });

/**
 * A change held for an admin's OK (hold_rules.ts), checked as its write would be: a chat line that waits on the
 * workspace's owners and admins, and nothing written to memory until one keeps it. The same change held twice is one.
 */
export function hold(hub: Hub, r: ProjectRef, item: RememberedItem, by: PersonRef | undefined): Record<string, unknown> {
  const file = nameOf(projectTarget(r, item.topic));
  const what = item.forgotten === true ? "Taking this line out" : "A line that loosens what asks or merges";
  const next = `Held for an admin's OK: ${what.toLowerCase()} waits until an owner or admin keeps it. Memory is as it was: act as it says until then.`;
  const same = (m: RememberedItem) => m.text === item.text && m.topic === item.topic && (m.forgotten === true) === (item.forgotten === true);
  if (heldLines(hub.db, r).some((m) => m.remembered !== undefined && same(m.remembered))) return { file, held: true, next };
  const text = item.forgotten === true ? `Waiting for an admin's OK to forget: ${item.text}` : `Waiting for an admin's OK: ${item.text}`;
  chat(hub).add(r, { author: "system", text, remembered: { ...item, ...(by ? { by } : {}), hold: "waiting" } });
  // It waits on the admins now: their needs-you changes with it.
  state(hub, r);
  return { file, held: true, next };
}

/** The chat line that says what was remembered or forgotten and offers Undo, and the event for Settings > Memory. */
function remembered(hub: Hub, r: ProjectRef, caller: LeadCaller, item: RememberedItem): void {
  changed(hub, item.scope === "project" ? r : undefined, item.topic, caller.by);
  if (caller.agent.kind === "memory_refresh") {
    if (caller.agent.person !== undefined) recordTidy(hub.db, caller.agent.person, item);
    else record(hub.db, r, item);
    return;
  }
  const where = item.scope === "user" ? ` for every bot${item.topic !== undefined ? ` (${item.topic})` : ""}` : item.topic !== undefined ? ` (${item.topic})` : "";
  const text =
    item.forgotten === true
      ? item.reason !== undefined
        ? `Forgot${where}: ${item.text} (${item.reason})`
        : `Forgot${where}: ${item.text}`
      : `Remembered${where}: ${item.text}`;
  chat(hub).add(r, { author: "system", text, remembered: item });
}

/** `memory.changed`, which tells the app to read the memory again. `project` undefined for `user.md`. */
export function changed(hub: Hub, project: ProjectRef | undefined, topic: string | undefined, by: string): void {
  events(hub).append({
    at: isoMs(nowMs(hub.clock)),
    type: "memory.changed",
    ...(project ? { machineId: project.machineId, projectId: project.projectId } : {}),
    summary: project
      ? `${topic === undefined ? INDEX_FILE : `${topic}.md`} of ${project.machineId}/${project.projectId} changed`
      : topic === undefined ? "user.md changed" : `${topic}.md of user memory changed`,
    data: { scope: project ? "project" : "user", projectRef: project ?? null, topic: topic ?? null, by },
  });
}
