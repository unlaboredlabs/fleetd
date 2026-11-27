// Share links' tools: `share_port` (a person's device names the machine; an agent's comes as a lead call from its
// own session, its machine the session's), `share_links_list`, `share_link_renew`, `share_link_revoke`,
// `share_link_open` (a signed-in device's one-time way in) and the admins' `share_links_settings_set`. Each change is
// an audit row of its own (`share_link.*`), written here, as an agent's share is no registry call.
import type { AuditActor, MachineId, ShareLink, SharePortOutput } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { settingsPath } from "../../shared/settings_path.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { isHuman } from "../api/grants.ts";
import { actorOf, botOf } from "../audit/record.ts";
import { auditLog } from "../audit/store.ts";
import { sessionOf } from "../intake/chat_file.ts";
import { leadCalls } from "../lead_calls/index.ts";
import type { LeadCaller } from "../lead_calls/types.ts";
import { people } from "../people/store.ts";
import { administrator } from "../people/tools.ts";
import { checkPreviewUrl, CODE_MS, enterUrl, isPort, lifeMinutes, MAX_MINUTES, MAX_OPEN, NAME, newToken } from "./rules.ts";
import { sendKept } from "./kept.ts";
import { codes, cut } from "./serve.ts";
import { type Held, isOpen, shareLinks, shown } from "./store.ts";

const PAGE = settingsPath("Share links");

const off = () =>
  new ToolError("forbidden", "Share links are off in this workspace.", `An owner or admin turns them on in ${PAGE}.`);

const noAddress = () =>
  new ToolError(
    "failed",
    "This workspace has no preview address yet, so a share link has nowhere to live.",
    `An owner or admin sets one in ${PAGE}: a wildcard name of its own, like https://preview.example.com (the docs' Share links page says how).`,
  );

const badMinutes = () => new ToolError("invalid", `minutes: 1 to ${MAX_MINUTES}.`);

/** The preview address links live under, or the refusal to make one without it. */
function base(hub: Hub): string {
  const url = shareLinks(hub).setting("preview_url");
  if (!url) throw noAddress();
  return url;
}

/** A link's row for `name`, open; else not_found. */
function openLink(hub: Hub, name: unknown): Held {
  const l = typeof name === "string" && NAME.test(name) ? shareLinks(hub).get(name) : undefined;
  if (!l || !isOpen(l, hub.clock.now())) {
    throw new ToolError("not_found", "That share link has ended or never was.", "Make a new one: share_port with the port.");
  }
  return l;
}

const audit = (hub: Hub, kind: string, actor: AuditActor, l: Held, summary: string, projectRef?: { machineId: string; projectId: string }) =>
  auditLog(hub).record({
    kind,
    actor,
    ...(projectRef ? { bot: botOf(hub, projectRef) } : {}),
    target: l.name,
    summary,
    data: { machine: l.machineId, port: l.port, expiresAt: new Date(l.expiresMs).toISOString() },
  });

const where = (l: Held) => `port ${l.port} on ${l.machineId}`;

export type Share = {
  machineId: MachineId;
  port: unknown;
  minutes?: unknown;
  label?: unknown;
  actor: AuditActor;
  projectId?: string;
  threadId?: string;
};

/** Shares a port: a new link, or the open one of that port renewed. */
export function share(hub: Hub, s: Share): ShareLink {
  const sl = shareLinks(hub);
  if (!sl.enabled()) throw off();
  const at = base(hub);
  if (!isPort(s.port)) throw new ToolError("invalid", "port: the dev server's TCP port on its machine, 1 to 65535.");
  const minutes = lifeMinutes(s.minutes);
  if (minutes === undefined) throw badMinutes();
  const label = typeof s.label === "string" && s.label.trim() !== "" ? s.label.trim().slice(0, 120) : undefined;
  const known = hub.db.conn.query("SELECT 1 FROM machines WHERE machine_id = ?").get(s.machineId);
  if (!known) throw new ToolError("not_found", `This workspace has no machine ${s.machineId}.`);
  const expiresMs = hub.clock.now() + minutes * 60_000;
  const ref = s.projectId !== undefined ? { machineId: s.machineId, projectId: s.projectId } : undefined;
  const already = sl.openAt(s.machineId, s.port);
  if (already) {
    const renewed = sl.renew(already.name, Math.max(expiresMs, already.expiresMs), label)!;
    audit(hub, "share_link.renew", s.actor, renewed, `Renewed the share link of ${where(renewed)}`, ref);
    sendKept(hub, renewed.machineId);
    return shown(renewed, at);
  }
  if (sl.open().length >= MAX_OPEN) {
    throw new ToolError("invalid", `This workspace has ${MAX_OPEN} share links open, the most it holds.`, `Stop one you no longer need in ${PAGE}.`);
  }
  const made = sl.create({
    machineId: s.machineId,
    port: s.port,
    ...(label !== undefined ? { label } : {}),
    createdBy: s.actor,
    ...(s.projectId !== undefined ? { projectId: s.projectId } : {}),
    ...(s.threadId !== undefined ? { threadId: s.threadId } : {}),
    expiresMs,
  });
  audit(hub, "share_link.create", s.actor, made, `Shared ${where(made)} for ${minutes} minutes`, ref);
  sendKept(hub, made.machineId);
  return shown(made, at);
}

/** A person's own device: a member of this workspace, signed in. */
function member(hub: Hub, caller: Caller): { personId: string; name: string } {
  const p = isHuman(caller) && caller.person !== undefined ? people(hub).get(caller.person.personId) : undefined;
  if (!p || p.removedAt !== undefined) {
    throw new ToolError("forbidden", "Only the workspace's members open and make share links, from their own devices.");
  }
  return { personId: p.personId, name: p.name };
}

/** The agent's share: its own session's machine, the agent named as the bot's. */
function agentShare(hub: Hub, caller: LeadCaller, call: Record<string, unknown>): SharePortOutput & { block: Record<string, unknown>; next: string } {
  const session = sessionOf(hub, caller);
  const link = share(hub, {
    machineId: session.machineId,
    port: call.port,
    minutes: call.minutes,
    label: call.label,
    actor: { kind: "agent", name: caller.agent.kind === "task" ? "An agent" : "The lead" },
    projectId: caller.projectRef.projectId,
    threadId: session.threadId,
  });
  const block = { v: 1, kind: "preview", name: link.name, port: link.port, ...(link.label !== undefined ? { label: link.label } : {}) };
  return {
    link,
    block,
    next:
      "Put the block in your message (a lead) or your result (a task) as a ```fleetd-block fence: the chat shows it as an Open preview card. " +
      `Only the workspace's signed-in members open it, until ${link.expiresAt}; share_port again renews it. ` +
      "The dev server keeps running after you end, until the link ends; then fleetd stops it.",
  };
}

export function registerLeadCalls(hub: Hub): void {
  leadCalls(hub).register("share_port", (caller, call) => agentShare(hub, caller, call));
}

export function register(tools: Registry): void {
  tools.add("share_port", (hub, caller, input) => {
    const who = member(hub, caller);
    return { link: share(hub, { machineId: input.machineId, port: input.port, minutes: input.minutes, label: input.label, actor: { kind: "person", ...who } }) };
  });
  tools.add("share_links_list", (hub) => {
    const sl = shareLinks(hub);
    const url = sl.setting("preview_url");
    return { enabled: sl.enabled(), links: url ? sl.open().map((l) => shown(l, url)) : [], ...(url ? { previewUrl: url } : {}) };
  });
  tools.add("share_link_renew", (hub, caller, input) => {
    const l = openLink(hub, input.name);
    const minutes = lifeMinutes(input.minutes);
    if (minutes === undefined) throw badMinutes();
    const renewed = shareLinks(hub).renew(l.name, hub.clock.now() + minutes * 60_000)!;
    audit(hub, "share_link.renew", actorOf(hub, caller), renewed, `Renewed the share link of ${where(renewed)} for ${minutes} minutes`);
    sendKept(hub, renewed.machineId);
    return { link: shown(renewed, base(hub)) };
  });
  tools.add("share_link_revoke", (hub, caller, input) => {
    const l = openLink(hub, input.name);
    shareLinks(hub).revoke(l.name);
    cut(hub, l.name);
    audit(hub, "share_link.revoke", actorOf(hub, caller), l, `Stopped the share link of ${where(l)}`);
    sendKept(hub, l.machineId);
    return {};
  });
  tools.add("share_link_open", (hub, caller, input) => {
    const who = member(hub, caller);
    if (!shareLinks(hub).enabled()) throw off();
    const l = openLink(hub, input.name);
    const code = newToken();
    codes(hub).put(code, { name: l.name, personId: who.personId, untilMs: hub.clock.now() + CODE_MS }, hub.clock.now());
    return { url: enterUrl(base(hub), l.name, code, input.to) };
  });
  tools.add("share_links_settings_set", (hub, caller, input) => {
    if (!administrator(hub, caller)) {
      throw new ToolError("forbidden", "Only the workspace's owners and admins turn share links on or off and set where they live.");
    }
    const sl = shareLinks(hub);
    const actor = actorOf(hub, caller);
    if (input.previewUrl !== undefined) {
      if (input.previewUrl.trim() === "") sl.set("preview_url", undefined);
      else {
        const checked = checkPreviewUrl(input.previewUrl, hub.url());
        if ("why" in checked) throw new ToolError("invalid", `previewUrl: ${checked.why}.`);
        sl.set("preview_url", checked.url);
      }
      auditLog(hub).record({ kind: "workspace.settings", actor, target: "Share links", summary: `Set the share links' address to ${sl.setting("preview_url") ?? "none"}` });
    }
    if (input.enabled !== undefined && input.enabled !== sl.enabled()) {
      sl.set("enabled", input.enabled ? "1" : "0");
      if (!input.enabled) for (const l of sl.open()) cut(hub, l.name);
      for (const machineId of new Set(sl.open().map((l) => l.machineId))) sendKept(hub, machineId);
      auditLog(hub).record({ kind: "share_link.switch", actor, target: "Share links", summary: input.enabled ? "Turned share links on" : "Turned share links off" });
    }
    const url = sl.setting("preview_url");
    return { enabled: sl.enabled(), ...(url ? { previewUrl: url } : {}) };
  });
}
