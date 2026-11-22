// The lead's `remember`, `forget` and `memory_read`, scoped to the caller's project by its session.
// User scope is a person's own memory: the one whose message the turn answers
// (a project's owner), and refused when that is nobody; a tidy's, the person it tidies. A nightly refresh's or tidy's
// changes are kept for its one line at the end.
import type { MemoryScope, PersonId, ProjectRef, RememberedItem } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { chat } from "../chat/index.ts";
import { LeadRecords } from "../leads/records.ts";
import { runHuman } from "../leads/requested.ts";
import { type LeadCall, type LeadCaller, leadCalls } from "../leads/seams.ts";
import { events } from "../store/events.ts";
import { isoMs, nowMs } from "../store/time.ts";
import { type ForgetCall, INDEX_FILE, isTopic, Memory, nameOf, projectTarget, type RememberCall, userTarget, type You, youOf } from "./index.ts";
import { record, refreshYou } from "./refresh_store.ts";
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

const entryOk = (s: unknown): s is string => typeof s === "string" && s.length >= 1 && s.length <= 1000 && !/[\r\n]/.test(s);

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
  const memory = Memory.of(hub);
  if (call.op === "remember") {
    const scope = scopeOf(call);
    if (!entryOk(call.text)) throw invalid("remember call: text is one line of 1 to 1000 characters");
    if (call.replaces !== undefined && !entryOk(call.replaces)) throw invalid("remember call: replaces is one line of 1 to 1000 characters");
    const remember: RememberCall = {
      scope,
      text: call.text,
      ...(call.topic === undefined ? {} : { topic: call.topic as string }),
      ...(call.replaces === undefined ? {} : { replaces: call.replaces as string }),
    };
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
