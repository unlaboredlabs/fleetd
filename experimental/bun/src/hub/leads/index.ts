// One lead per project (crates/fleetd/src/hub/leads/lead.rs): a thread on the project's machine, started with the lead
// prompt plus the digest. A project with no repo's lead does its own work, from `assistant.start` in the assistant
// role; no lead starts while its project is archived. `leads(hub)` is the area other areas read: `get` (a Lead with
// its state off its thread), `list`, and `leadProfile`.
import type { ChatMessage, Lead, ProjectRef, ProjectSummary, UsageParked } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { chat } from "../chat/index.ts";
import { Memory, youForLead } from "../memory/index.ts";
import { type LeadMcpSet, mcpServers, newSince } from "../mcp_servers/index.ts";
import { leadPeople } from "../people/store.ts";
import { profiles } from "../projects/profiles.ts";
import { prompts } from "../prompts/store.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { isoMs, nowMs, parseMs } from "../store/time.ts";
import { archivedNote, LeadWakes, triggerLines } from "./lead_wakes.ts";
import { leadState } from "./lead_state.ts";
import { leadWiring } from "./ports.ts";
import { renderLeadStart, reposBlock, startPrompt, whole } from "./prompt.ts";
import { LeadRecords, type StoredLead } from "./records.ts";
import { clip } from "./text.ts";
import { ofChat, short, told } from "./zone.ts";

export { leadState } from "./lead_state.ts";

/** What the usage area says of a parked lead thread; set by that area once it is ported. */
export type ParkedOf = (thread: { machineId: string; threadId: string }) => UsageParked | undefined;

/** What an order for a project without a lead did about the lead: it had one, this call started it, or it waits. */
export type AutoStart = { kind: "running"; lead: Lead } | { kind: "started"; lead: Lead } | { kind: "held"; error: ToolError };

/** A lead idle this long has lost its prompt cache (1 hour for leads). */
export const LEAD_FRESH_AFTER_MS = 3_600_000;
/** The chat messages a fresh lead session reads, newest last; each cut. */
const RECENT_CHAT = 12;
const RECENT_CHAT_CHARS = 500;

export class Leads {
  readonly records: LeadRecords;
  readonly wakes: LeadWakes;
  /** The usage area's hook (Rust `LeadHooks::parked_of`): none until it sets one. */
  parkedOf: ParkedOf = (thread) => leadWiring(this.hub).hooks.parkedOf?.(thread);
  /** Serializes start and restart, so two concurrent calls for one project launch one thread. */
  private lock: Promise<void> = Promise.resolve();

  constructor(private readonly hub: Hub) {
    this.records = new LeadRecords(hub.db);
    this.wakes = new LeadWakes(hub);
    this.wakes.freshIfDue = async (r, first) => (await this.freshIfDue(r, first)) !== undefined;
  }

  private async locked<T>(f: () => Promise<T>): Promise<T> {
    const before = this.lock;
    let done!: () => void;
    this.lock = new Promise((resolve) => (done = resolve));
    await before;
    try {
      return await f();
    } finally {
      done();
    }
  }

  /** The project's lead with its state, or undefined when it has none. */
  get(r: ProjectRef): Lead | undefined {
    const lead = this.records.leadGet(r);
    return lead ? this.withState(lead) : undefined;
  }

  /** Every project's lead, by machine and project. */
  list(): Lead[] {
    return this.records.leadsList().map((l) => this.withState(l));
  }

  withState(lead: StoredLead): Lead {
    const ref = { machineId: lead.projectRef.machineId, threadId: lead.threadId };
    const thread = store(this.hub).threadGet(ref)?.thread;
    const parked = this.parkedOf(ref);
    const gone = store(this.hub).projectGet(lead.projectRef) === undefined;
    return {
      state: leadState(thread, gone),
      projectRef: lead.projectRef,
      threadId: lead.threadId,
      startedAt: lead.startedAt,
      ...(lead.lastWakeAt === undefined ? {} : { lastWakeAt: lead.lastWakeAt }),
      sessionGeneration: lead.sessionGeneration,
      ...(parked === undefined ? {} : { parked }),
    };
  }

  private refuseArchived(r: ProjectRef): void {
    const note = archivedNote(this.hub, r);
    if (note) throw new ToolError("invalid", note.message, note.fix);
  }

  /** Why an archived project's lead doesn't start or take a message; undefined for any other project. */
  private archived(r: ProjectRef): ToolError | undefined {
    const project = store(this.hub).projectGet(r);
    if (!project || project.archivedAt === undefined) return undefined;
    return new ToolError(
      "invalid",
      `${project.title} is archived: its lead doesn't start.`,
      "Bring it back with navi_archive (archived false) or in the app; a message waits until then.",
    );
  }

  private projectOf(r: ProjectRef): ProjectSummary {
    const p = store(this.hub).projectGet(r);
    if (!p) throw new ToolError("not_found", `No project ${r.projectId} on ${r.machineId}.`, `Call project_get with machineId ${r.machineId} and no projectId.`);
    return p;
  }

  /** Launches the project's lead, or returns the one it already has. */
  async start(r: ProjectRef): Promise<Lead> {
    return (await this.startWith(r)).lead;
  }

  private startWith(r: ProjectRef, first?: string): Promise<{ lead: Lead; launched: boolean }> {
    return this.locked(async () => {
      this.refuseArchived(r);
      const held = this.archived(r);
      if (held) throw held;
      const existing = this.records.leadGet(r);
      if (existing) return { lead: this.withState(existing), launched: false };
      return { lead: await this.launch(r, this.projectOf(r), 0, first), launched: true };
    });
  }

  /** Starts the project's lead for its waiting orders; `first`, the chat message that starts it, ends its first message. */
  async autoStart(r: ProjectRef, first?: string): Promise<AutoStart> {
    try {
      this.refuseArchived(r);
      const held = this.archived(r);
      if (held) return { kind: "held", error: held };
      const lead = this.get(r);
      if (lead) return { kind: "running", lead };
      const out = await this.startWith(r, first);
      return out.launched ? { kind: "started", lead: out.lead } : { kind: "running", lead: out.lead };
    } catch (error) {
      if (error instanceof ToolError) return { kind: "held", error };
      throw error;
    }
  }

  /** Starts the lead of each project on `machineId` that has orders waiting as drafts and no lead. */
  async startWaiting(machineId: string): Promise<void> {
    for (const project of store(this.hub).projectsShown(machineId)) {
      const r = { machineId: project.machineId, projectId: project.projectId };
      if (this.records.leadGet(r)) continue;
      const open = this.records.workstreamsList({ projectRef: r, state: "open", limit: 100 });
      if (open.every((w) => w.brief !== undefined)) continue;
      const out = await this.autoStart(r);
      if (out.kind === "held") console.info(`waiting orders: the lead of ${project.title} still not started: ${out.error.message}`);
    }
  }

  /** A fresh lead thread from the current digest; bumps `sessionGeneration`. The old thread stays on the node. */
  restart(r: ProjectRef): Promise<Lead> {
    return this.locked(async () => {
      const existing = this.records.leadGet(r);
      if (!existing) throw new ToolError("not_found", `Project ${r.projectId} on ${r.machineId} has no lead to restart.`, "Call lead_start first.");
      return this.launch(r, this.projectOf(r), existing.sessionGeneration + 1);
    });
  }

  /** The project's lead and when its thread last moved, while it is idle. */
  private idle(r: ProjectRef): { lead: StoredLead; since?: number } | undefined {
    const lead = this.records.leadGet(r);
    if (!lead) return undefined;
    const thread = store(this.hub).threadGet({ machineId: r.machineId, threadId: lead.threadId })?.thread;
    if (!thread || leadState(thread, false) !== "idle") return undefined;
    const since = parseMs(thread.lastProgressAt);
    return { lead, ...(since === undefined ? {} : { since }) };
  }

  /** Whether the lead is idle and has been since before LEAD_FRESH_AFTER: its prompt cache is gone. */
  cold(r: ProjectRef): boolean {
    const idle = this.idle(r);
    return idle?.since !== undefined && nowMs(this.hub.clock) - idle.since > LEAD_FRESH_AFTER_MS;
  }

  /** While the lead is idle and its MCP servers differ from those its session started with: before and now. */
  private mcpChanged(r: ProjectRef): { before: LeadMcpSet; now: LeadMcpSet } | undefined {
    const lead = this.records.leadGet(r);
    if (!lead) return undefined;
    let now: LeadMcpSet;
    try {
      now = this.leadSet(r);
    } catch {
      return undefined;
    }
    const before = this.records.leadMcpGet(r, lead.threadId) as LeadMcpSet | undefined;
    if (before === undefined) {
      this.records.leadMcpPut(r, lead.threadId, now);
      return undefined;
    }
    return JSON.stringify(before) !== JSON.stringify(now) && this.idle(r) ? { before, now } : undefined;
  }

  private leadSet(r: ProjectRef): LeadMcpSet {
    return mcpServers(this.hub).leadSet(r);
  }

  /** Whether the lead's next turn starts a fresh session: it is cold, or its MCP servers changed. */
  freshDue(r: ProjectRef): boolean {
    return this.cold(r) || this.mcpChanged(r) !== undefined;
  }

  /** When fresh is due: a fresh lead session instead, from the digest (and memory), then the chat's tail and `first`. */
  freshIfDue(r: ProjectRef, first: string): Promise<Lead | undefined> {
    return this.locked(async () => {
      const changed = this.mcpChanged(r);
      const existing = this.records.leadGet(r);
      if (!existing || (!changed && !this.cold(r))) return undefined;
      const project = this.projectOf(r);
      // A digest as of no wake, as at any start.
      const { lastWakeAt: _, ...rest } = existing;
      this.records.leadPut(rest);
      const chatTail = this.recentChat(r);
      const text = chatTail === undefined ? first.trim() : `${chatTail}\n\n${first.trim()}`;
      const lead = await this.launch(r, project, existing.sessionGeneration + 1, text);
      if (changed) {
        const names = newSince(changed.now, changed.before);
        const line = connectedLine(names);
        if (line !== undefined) {
          try {
            chat(this.hub).systemLine(r, line);
          } catch (error) {
            console.warn("the lead's new MCP servers were not said in the chat:", error);
          }
        }
      }
      return lead;
    });
  }

  /** The profiles the project's tasks may run on, the default first. */
  allowedProfiles(r: ProjectRef): string[] {
    return profiles(this.hub).allowed(r);
  }

  /** `project_set`: saves what the project allows besides the default and tells the clients. */
  setAllowedProfiles(r: ProjectRef, title: string, names: string[]): string[] {
    profiles(this.hub).setAllowed(r, names);
    const allowed = this.allowedProfiles(r);
    events(this.hub).append({
      at: isoMs(nowMs(this.hub.clock)),
      type: "project.settings",
      machineId: r.machineId,
      projectId: r.projectId,
      summary: `${title}: agents may run on ${allowed.join(", ")}`,
      data: { profiles: allowed },
    });
    return allowed;
  }

  /** The drafts waiting for this lead whose order says more than its title, oldest first, as a wake says a new order. */
  private waitingOrders(r: ProjectRef): string | undefined {
    const open = this.records.workstreamsList({ projectRef: r, state: "open", limit: 100 });
    const triggers = open
      .reverse()
      .filter((w) => w.brief === undefined && w.source.text.trim() !== w.title.trim())
      .map((w) => ({ kind: "intent" as const, workstreamId: w.workstreamId, text: w.source.text }));
    return triggers.length === 0 ? undefined : `Orders waiting for you:\n${triggerLines(triggers).join("\n")}`;
  }

  /** The project's last few chat messages between the human, the lead and agents, for a fresh lead session. */
  private recentChat(r: ProjectRef): string | undefined {
    const rows = this.hub.db.all<{ data: string }>(
      "SELECT data FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2 AND held = 0 ORDER BY seq DESC LIMIT 200",
      [r.machineId, r.projectId],
    );
    const zone = ofChat(this.hub.db, r);
    const lines: string[] = [];
    for (const row of rows) {
      if (lines.length >= RECENT_CHAT) break;
      let m: ChatMessage;
      try {
        m = JSON.parse(row.data) as ChatMessage;
      } catch {
        continue;
      }
      if (!m.text.trim()) continue;
      const who = m.author === "human" ? "Human" : m.author === "lead" ? "You" : m.author === "agent" ? `Agent ${m.by ?? ""}` : undefined;
      if (who === undefined) continue;
      const ms = parseMs(m.createdAt);
      lines.push(`${who.trim()}${ms === undefined ? "" : ` (${short(zone, ms)})`}: ${clip(m.text.trim(), RECENT_CHAT_CHARS)}`);
    }
    if (lines.length === 0) return undefined;
    lines.reverse();
    return `## Recent chat\nYour session started fresh; the chat before this is not in it. Times are in ${told(zone)}.\n${lines.join("\n")}`;
  }

  private async launch(r: ProjectRef, project: ProjectSummary, sessionGeneration: number, first?: string): Promise<Lead> {
    this.refuseArchived(r);
    const held = this.archived(r);
    if (held) throw held;
    const wiring = leadWiring(this.hub);
    // No lead turn goes into a login fleetd knows is exhausted.
    const paused = wiring.hooks.usageGate?.(r);
    if (paused !== undefined) {
      throw new ToolError(
        "invalid",
        `The lead was not started: ${paused}.`,
        "It goes on by itself at the reset. Once the login has capacity, the human can press Resume in the app or run fleetd usage resume on the hub machine.",
      );
    }
    // Taken before the digest is read: every intent made before it is in the first message.
    const at = isoMs(nowMs(this.hub.clock));
    const set = prompts(this.hub.db).current(r);
    const store_ = profiles(this.hub);
    const names = store_.allowed(r);
    const allowed = store_.list().filter((p) => names.includes(p.name));
    const { text: digest, idleSince } = this.wakes.digestToSend(r);
    const manual = wiring.ports.oneLeadMode(r.machineId);
    const ownWork = manual ? (project.repos ?? []).length === 0 : project.kind === "assistant";
    const leadProfile = store_.leadProfile();
    const start = renderLeadStart(
      set,
      r,
      project.title,
      allowed,
      digest,
      Memory.of(this.hub).injected(r, true, youForLead(this.hub.db, r)),
      leadPeople(this.hub.db),
      ownWork ? project.workspaceRoot : undefined,
    );
    let prompt = start.first;
    const repos = reposBlock(r, project.repos ?? []);
    if (repos !== undefined) prompt = `${prompt.trimEnd()}\n\n${repos}`;
    const waiting = this.waitingOrders(r);
    if (waiting !== undefined) prompt = `${prompt.trimEnd()}\n\n${waiting}`;
    if (first !== undefined) prompt = `${prompt.trimEnd()}\n\n${first.trimEnd()}`;
    const launchedMs = nowMs(this.hub.clock);
    // Read before the launch: a change that lands meanwhile starts the next turn fresh again.
    let mcp: LeadMcpSet | undefined;
    try {
      mcp = this.leadSet(r);
    } catch (error) {
      console.warn("the lead's MCP servers were not read:", error);
    }
    const threadId = await wiring.ports.launch(
      r.machineId,
      {
        projectId: r.projectId,
        prompt,
        systemPrompt: start.system,
        profile: leadProfile.name,
        runtimeMode: manual || ownWork ? "approval-required" : "full-access",
        title: [...`fleetd lead: ${project.title}`].slice(0, 80).join(""),
        // The node's launch is idempotent on the id, so the id names this launch.
        clientRequestId: `fleetd-lead:${r.machineId}/${r.projectId}:${sessionGeneration}:${launchedMs}`,
      },
      ownWork ? "assistant" : "lead",
    );
    this.wakes.idleSent(r, idleSince);
    if (mcp !== undefined) this.records.leadMcpPut(r, threadId, mcp);
    let textSha = "";
    try {
      textSha = prompts(this.hub.db).pin(set, "lead", r, threadId, at, whole({ ...start, first: prompt }));
    } catch (error) {
      // The lead runs either way; its wakes then follow the current texts.
      console.warn("lead prompts not pinned:", error);
    }
    const lead: StoredLead = { projectRef: r, threadId, startedAt: at, sessionGeneration };
    this.records.leadPut(lead);
    // Its lane names the profile this session runs on, not a later pick.
    this.records.leadProfilePut(r, threadId, leadProfile.name);
    events(this.hub).append({
      at,
      type: "lead.started",
      machineId: r.machineId,
      projectId: r.projectId,
      threadId,
      summary: `Lead of ${project.title} started (session ${sessionGeneration})`,
      data: { sessionGeneration, profile: leadProfile.name, promptRef: set.get(startPrompt(ownWork)).ref, textSha },
    });
    return this.withState(lead);
  }
}

/** The chat's line for the MCP servers a fresh lead session gets that its last one didn't. */
function connectedLine(names: string[]): string | undefined {
  const last = names[names.length - 1];
  if (last === undefined) return undefined;
  const rest = names.slice(0, -1);
  return rest.length === 0 ? `${last} is connected: I can use it now.` : `${rest.join(", ")} and ${last} are connected: I can use them now.`;
}

/** The hub's leads area: `leads(hub).get(r)`, `leads(hub).list()`. */
export const leads = (hub: Hub) => hub.area("leads", (h) => new Leads(h));

/** The profile the project's current lead session started on (records.rs `lead_profile_get`). */
export const leadProfile = (hub: Hub, r: ProjectRef) => leads(hub).records.leadProfileGet(r);

