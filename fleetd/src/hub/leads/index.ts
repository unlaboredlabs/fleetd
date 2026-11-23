// One lead per project: a thread on the project's machine, started with the lead
// prompt plus the digest. A project with no repo's lead does its own work, from `assistant.start` in the assistant
// role; no lead starts while its project is archived. `leads(hub)` is the area other areas read: `get` (a Lead with
// its state off its thread), `list`, and `leadProfile`.
import type { ChatMessage, Lead, Profile, ProjectRef, ProjectSummary, UsageParked } from "../../shared/contracts.ts";
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
import { chatTagsOn } from "../project_lead/store.ts";
import { LeadRecords, type StoredLead } from "./records.ts";
import { clip, oneLine } from "./text.ts";
import { ofChat, short, told } from "./zone.ts";

export { leadState } from "./lead_state.ts";

/** What the usage area says of a parked lead thread; set by that area once it is ported. */
export type ParkedOf = (thread: { machineId: string; threadId: string }) => UsageParked | undefined;

/** What an order for a project without a lead did about the lead: it had one, this call started it, or it waits. */
/** `held` carries why, as the error and its message (the automations area reads `message`). */
export type AutoStart = { kind: "running"; lead: Lead } | { kind: "started"; lead: Lead } | { kind: "held"; error: ToolError; message: string };

const heldBy = (error: ToolError): AutoStart => ({ kind: "held", error, message: error.message });

/** A lead idle this long has lost its prompt cache (1 hour for leads). */
export const LEAD_FRESH_AFTER_MS = 3_600_000;
/** The chat messages a fresh lead session reads, newest last; each cut. */
const RECENT_CHAT = 12;
const RECENT_CHAT_CHARS = 500;
/** The most of a file's name a recap line carries. */
const RECENT_CHAT_NAME = 80;
/**
 * The last line of a session started again with no wake behind it (a profile switch, `lead_start {fresh: true}`): its
 * recent chat ends on turn-shaped lines, which invite a model to write the next one itself. It speaks for the chat
 * alone: the state and the orders waiting above it still stand.
 */
export const STARTED_AGAIN =
  "This is your session starting again: the chat messages above were already seen and handled. The state and any orders waiting above still stand: act on them, on a wake or on a person's new message, and never write a message for them.";

export class Leads {
  readonly records: LeadRecords;
  readonly wakes: LeadWakes;
  /** The usage area's hook (Rust `LeadHooks::parked_of`): none until it sets one. */
  parkedOf: ParkedOf = (thread) => leadWiring(this.hub).hooks.parkedOf?.(thread);
  /** Serializes start and restart, so two concurrent calls for one project launch one thread. */
  private lock: Promise<void> = Promise.resolve();
  /** Set once this process marked the leads for its own restart: the switches are the next hub process's to make. */
  private restarting = false;

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
      "Bring it back with project_archive (archived false) or in the app; a message waits until then.",
    );
  }

  private projectOf(r: ProjectRef): ProjectSummary {
    const p = store(this.hub).projectGet(r);
    if (!p) throw new ToolError("not_found", `No bot ${r.projectId} on ${r.machineId}.`, `Call project_get with machineId ${r.machineId} and no projectId.`);
    return p;
  }

  /**
   * Launches the project's lead, or returns the one it already has. One started ahead that hasn't run a turn starts
   * for real, as a lead launched now does: its first turn reads its start.
   */
  async start(r: ProjectRef): Promise<Lead> {
    const { lead, launched } = await this.startWith(r);
    if (launched) return lead;
    return this.locked(async () => {
      const ahead = this.aheadUnrun(r);
      return ahead ? this.launch(r, this.projectOf(r), ahead.lead.sessionGeneration + 1) : (this.get(r) ?? lead);
    });
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

  /**
   * Starts a new bot's lead with no turn, so its first message finds it ready: its computer comes up and claude waits,
   * and the start text this launch builds goes in with that message (the node keeps it). Says nothing when it can't
   * start: the first message then starts the lead as it would have. A lead the bot already has is left as it is.
   */
  async startAhead(r: ProjectRef): Promise<void> {
    try {
      await this.locked(async () => {
        if (this.records.leadGet(r) || this.archived(r)) return;
        await this.launch(r, this.projectOf(r), 0, undefined, true);
      });
    } catch (error) {
      console.info(`the lead of ${r.machineId}/${r.projectId} was not started ahead; its first message starts it: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Starts the project's lead for its waiting orders; `first`, the chat message that starts it, ends its first message. */
  async autoStart(r: ProjectRef, first?: string): Promise<AutoStart> {
    try {
      this.refuseArchived(r);
      const held = this.archived(r);
      if (held) return heldBy(held);
      const lead = this.get(r);
      if (lead) return { kind: "running", lead };
      const out = await this.startWith(r, first);
      return out.launched ? { kind: "started", lead: out.lead } : { kind: "running", lead: out.lead };
    } catch (error) {
      // Every refusal holds the message, as Rust's `LeadError`: an executor's or store's too.
      return heldBy(error instanceof ToolError ? error : new ToolError("failed", error instanceof Error ? error.message : String(error)));
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

  /**
   * A fresh lead thread from the current digest and the chat's tail; bumps `sessionGeneration`. The old thread stays
   * on the node.
   */
  restart(r: ProjectRef): Promise<Lead> {
    return this.locked(async () => {
      const existing = this.records.leadGet(r);
      if (!existing) throw new ToolError("not_found", `Bot ${r.projectId} on ${r.machineId} has no lead to restart.`, "Call lead_start first.");
      return this.launch(r, this.projectOf(r), existing.sessionGeneration + 1, this.startedAgain(r));
    });
  }

  /** The project's lead and when its thread last moved, while it is idle or its node no longer has the thread (gone). */
  private idle(r: ProjectRef): { lead: StoredLead; since?: number; gone?: true } | undefined {
    const lead = this.records.leadGet(r);
    if (!lead) return undefined;
    const thread = store(this.hub).threadGet({ machineId: r.machineId, threadId: lead.threadId })?.thread;
    if (!thread || (!thread.stale && leadState(thread, false) !== "idle")) return undefined;
    const since = parseMs(thread.lastProgressAt);
    return { lead, ...(since === undefined ? {} : { since }), ...(thread.stale ? { gone: true as const } : {}) };
  }

  /** Whether the lead is idle and has been since before LEAD_FRESH_AFTER, or its thread is gone: its prompt cache is gone. */
  cold(r: ProjectRef): boolean {
    const idle = this.idle(r);
    if (idle?.gone) return true;
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

  /**
   * Whether the lead's next turn starts a fresh session: it is cold, its MCP servers changed, its profile switch is due,
   * or it was started ahead on what its bot has changed since.
   */
  freshDue(r: ProjectRef): boolean {
    return this.cold(r) || this.mcpChanged(r) !== undefined || this.switchReady(r) || this.aheadStale(r);
  }

  /** What a lead's start hangs on besides the digest: whether it does its own work (no repo), and its bot's repos. */
  private shapeOf(r: ProjectRef, project: ProjectSummary): string {
    const ownWork = leadWiring(this.hub).ports.oneLeadMode(r.machineId) && (project.repos ?? []).length === 0;
    return JSON.stringify({ ownWork, repos: reposBlock(r, project.repos ?? []) ?? null });
  }

  /** The project's lead while its session was started ahead (`startAhead`) and hasn't run a turn, and what it was
   * started on (`shapeOf`). */
  private aheadUnrun(r: ProjectRef): { lead: StoredLead; shape: string } | undefined {
    const lead = this.records.leadGet(r);
    if (!lead) return undefined;
    const started = this.hub.db.all<{ shape: string | null }>(
      `SELECT json_extract(data, '$.data.shape') AS shape FROM events
       WHERE type = 'lead.started' AND machine_id = ?1 AND json_extract(data, '$.threadId') = ?2 ORDER BY seq DESC LIMIT 1`,
      [r.machineId, lead.threadId],
    )[0];
    if (started?.shape == null) return undefined;
    const ran = this.hub.db.all<{ n: number }>(
      `SELECT 1 AS n FROM events WHERE type IN ('thread.started', 'thread.completed', 'thread.failed', 'thread.interrupted')
       AND machine_id = ?1 AND json_extract(data, '$.threadId') = ?2 LIMIT 1`,
      [r.machineId, lead.threadId],
    );
    return ran.length > 0 ? undefined : { lead, shape: started.shape };
  }

  /**
   * A lead started ahead that hasn't run a turn, whose bot's repos changed since its start was built, as repos a new
   * bot's dialog adds after making it do: that start says the wrong repos (and maybe the wrong role).
   */
  private aheadStale(r: ProjectRef): boolean {
    const ahead = this.aheadUnrun(r);
    const project = ahead && store(this.hub).projectGet(r);
    return project !== undefined && ahead!.shape !== this.shapeOf(r, project);
  }

  /** What the project's lead session started now is launched with: its lead profile's name, model, effort and fast mode. */
  private launchedNow(r: ProjectRef): string {
    const store_ = profiles(this.hub);
    const { profile, model, effort, fast } = store_.chosen(store_.leadProfileFor(r).name);
    return JSON.stringify({ profile, model: model ?? null, effort, fast });
  }

  /**
   * Whether the project's lead profile (its own pick, else the hub's) is another, or has another model, effort or fast
   * mode, than its lead session started on. A session from before fleetd kept what it was launched with: the profile's name differs, or it was
   * edited since the session started.
   */
  profileChanged(r: ProjectRef): boolean {
    const lead = this.records.leadGet(r);
    if (!lead) return false;
    const was = this.records.leadLaunchedGet(r);
    if (was !== undefined) return was !== this.launchedNow(r);
    const now = profiles(this.hub).leadProfileFor(r);
    const name = this.records.leadProfileGet(r);
    return (name !== undefined && name !== now.name) || (parseMs(now.updatedAt) ?? 0) > (parseMs(lead.startedAt) ?? 0);
  }

  /**
   * Marks every lead whose profile changed since its session started: each starts again on the current one once it is
   * idle and its machine is linked (`switchIfDue`). Returns how many. Called as the hub restarts from Settings.
   */
  markProfileSwitches(): number {
    let marked = 0;
    for (const lead of this.records.leadsList()) {
      const project = store(this.hub).projectGet(lead.projectRef);
      if (!project || project.archivedAt !== undefined || !this.profileChanged(lead.projectRef)) continue;
      this.records.leadSwitchSet(lead.projectRef, true);
      marked += 1;
    }
    this.restarting = true;
    return marked;
  }

  /**
   * `project_set` leadRestart: the project's lead starts again on its lead profile now, keeping its chat, memory and orders:
   * a turn under way is stopped first, as the chat's Stop does, then it starts at once; one whose machine doesn't answer
   * starts once its turn ends or its machine is back. Its profile needn't have changed: a stuck lead is started again on
   * the one it runs on. False when the project has no lead.
   */
  async switchSoon(r: ProjectRef): Promise<boolean> {
    if (!this.records.leadGet(r)) return false;
    this.records.leadSwitchSet(r, "asked");
    await this.switchIfDue(r).catch((error) => console.info(`lead profile switch: ${r.projectId} on ${r.machineId} waits: ${error instanceof Error ? error.message : String(error)}`));
    return true;
  }

  /** The lead's profile switch is due, it still differs (or a person asked for it), and the lead is idle. */
  private switchReady(r: ProjectRef): boolean {
    return !this.restarting && this.records.leadSwitchDue(r) && this.idle(r) !== undefined && this.switchWanted(r);
  }

  /** A marked lead still has a reason to start again: its profile changed since its session started, or a person asked. */
  private switchWanted(r: ProjectRef): boolean {
    return this.records.leadRestartAsked(r) || this.profileChanged(r);
  }

  /**
   * A lead marked by `markProfileSwitches` starts again on its current profile, as `restart` does: it keeps its chat,
   * memory and open orders. One that is mid-turn stays marked until its turn ends, unless a person asked: then its turn
   * is stopped (or its stalled thread left) and it starts now. One whose profile is the one it runs on again (and no
   * person asked), or whose project is gone or archived, is unmarked.
   */
  switchIfDue(r: ProjectRef): Promise<Lead | undefined> {
    return this.locked(async () => {
      if (this.restarting || !this.records.leadSwitchDue(r)) return undefined;
      const project = store(this.hub).projectGet(r);
      if (!project || project.archivedAt !== undefined || !this.switchWanted(r)) {
        this.records.leadSwitchSet(r, false);
        return undefined;
      }
      const lead = this.records.leadGet(r)!;
      if (this.records.leadRestartAsked(r)) {
        // A person's Restart lead stops the turn under way first; while its machine can't, it stays marked.
        const thread = store(this.hub).threadGet({ machineId: r.machineId, threadId: lead.threadId })?.thread;
        if (thread && !thread.stale && (thread.status === "running" || thread.status === "waiting")) {
          await leadWiring(this.hub).ports.interrupt({ machineId: r.machineId, threadId: lead.threadId });
        }
      } else if (!this.idle(r)) return undefined;
      // Its first turn reads the chat it carries on, as `freshIfDue`'s does: a start with the digest alone left a lead with
      // nothing to answer, and it made up a message from the person (W787).
      return this.launch(r, project, lead.sessionGeneration + 1, this.startedAgain(r));
    });
  }

  /** When fresh is due: a fresh lead session instead, from the digest (and memory), then the chat's tail and `first`. */
  freshIfDue(r: ProjectRef, first: string): Promise<Lead | undefined> {
    return this.locked(async () => {
      const changed = this.mcpChanged(r);
      const existing = this.records.leadGet(r);
      if (!existing || (!changed && !this.cold(r) && !this.switchReady(r) && !this.aheadStale(r))) return undefined;
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

  /**
   * `project_set` leadProfile: the profile the project's lead starts on from its next start, by name; undefined drops
   * its pick, back to the hub's lead profile. A name no profile has is refused. Tells the clients; returns the one its
   * lead starts on now.
   */
  setLeadProfile(r: ProjectRef, title: string, name: string | undefined): Profile {
    const store_ = profiles(this.hub);
    const picked = name === undefined ? undefined : store_.byName(name);
    if (name !== undefined && picked === undefined) {
      throw new ToolError("invalid", `No profile is named ${name}.`, `Pick one of: ${store_.list().map((p) => p.name).join(", ")}.`);
    }
    store_.setLeadPick(r, picked?.id);
    const lead = store_.leadProfileFor(r);
    events(this.hub).append({
      at: isoMs(nowMs(this.hub.clock)),
      type: "project.settings",
      machineId: r.machineId,
      projectId: r.projectId,
      summary: `${title}: its lead starts on ${lead.name}${picked ? "" : ", the hub's lead profile"}`,
      data: { leadProfile: picked?.name ?? null },
    });
    return lead;
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

  /** A session started again with no wake behind it: its recent chat, then that nothing new waits (STARTED_AGAIN). */
  private startedAgain(r: ProjectRef): string {
    const chatTail = this.recentChat(r);
    return chatTail === undefined ? STARTED_AGAIN : `${chatTail}\n\n${STARTED_AGAIN}`;
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
      // Its files by id and name only: the lead saves one with attachment_read, or names its id to an agent.
      const files = (m.attachments ?? []).map((f) => `${f.attachmentId} "${oneLine(f.name, RECENT_CHAT_NAME)}"`);
      const said = [clip(m.text.trim(), RECENT_CHAT_CHARS), files.length === 0 ? "" : `[attached: ${files.join(", ")}]`].filter(Boolean).join(" ");
      if (!said) continue;
      const agent = m.lead === undefined ? `Agent ${m.by ?? ""}` : m.lead.to !== undefined ? `You, to the lead of ${m.lead.to}` : `The lead of ${m.by ?? ""}`;
      const who = m.author === "human" ? "Human" : m.author === "lead" ? "You" : m.author === "agent" ? agent : undefined;
      if (who === undefined) continue;
      const ms = parseMs(m.createdAt);
      lines.push(`${who.trim()}${ms === undefined ? "" : ` (${short(zone, ms)})`}: ${said}`);
    }
    if (lines.length === 0) return undefined;
    lines.reverse();
    return `## Recent chat\nYour session started fresh; the chat before this is not in it. Times are in ${told(zone)}.\n${lines.join("\n")}`;
  }

  /** `ahead`: the node starts it with no turn and keeps the start text for its first message (`startAhead`). */
  private async launch(r: ProjectRef, project: ProjectSummary, sessionGeneration: number, first?: string, ahead = false): Promise<Lead> {
    this.refuseArchived(r);
    const held = this.archived(r);
    if (held) throw held;
    const wiring = leadWiring(this.hub);
    const moved = wiring.hooks.moved?.();
    if (moved !== undefined) throw new ToolError("invalid", `The lead was not started: ${moved}.`, "Its bots run on fleetd cloud now. To run them here again, press Undo on this hub's banner.");
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
    const ownWork = manual && (project.repos ?? []).length === 0;
    const leadProfile = store_.leadProfileFor(r);
    // Read before the launch, as the launch reads it: an edit that lands meanwhile reads as changed.
    const launched = this.launchedNow(r);
    const start = renderLeadStart(
      set,
      r,
      project.title,
      allowed,
      digest,
      Memory.of(this.hub).injected(r, true, youForLead(this.hub.db)),
      leadPeople(this.hub.db),
      ownWork ? project.workspaceRoot : undefined,
      chatTagsOn(this.hub.db.conn, r),
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
        ...(ahead ? { ahead: true as const } : {}),
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
    this.records.leadProfilePut(r, threadId, leadProfile.name, launched);
    events(this.hub).append({
      at,
      type: "lead.started",
      machineId: r.machineId,
      projectId: r.projectId,
      threadId,
      summary: `Lead of ${project.title} started (session ${sessionGeneration}${ahead ? ", ahead of its first message" : ""})`,
      // An ahead start's shape: its bot's first message starts it fresh if that changes before its first turn.
      data: { sessionGeneration, profile: leadProfile.name, promptRef: set.get(startPrompt(ownWork)).ref, textSha, ...(ahead ? { ahead: true, shape: this.shapeOf(r, project) } : {}) },
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

