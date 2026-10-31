// The hubs this app is paired with: their list in <fleetd dir>/desktop-hubs.json, in sidebar
// order and with no keys in it, and one HubService per hub, each with its own key, connection and offline cache. The
// first hub keeps the files the app had before it paired with several, so an upgraded app already is that hub. The
// list is never empty: a fresh app has one hub, not paired yet, which onboarding pairs, and removing the last hub only
// forgets its key. A hub's id is never used twice: what the app keeps per hub (its key, its cache, the page's marks)
// must never pass to another.
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ConnectOutcome } from "../../shared/hub";
import { hubOrigin } from "../../shared/pairing";
import { cleanLabel, defaultLabel, FIRST_HUB, HUB_COLORS, HUB_ID, LABEL_MAX, type HubColor, type HubEntry, type HubId, type PairTarget } from "../../shared/hubs";
import type { PresenceFrame } from "../presence";
import { HubCacheFile } from "./cache";
import { fromEnv, loadCredentials, writePrivate, type CredentialEnv, type Loaded } from "./credentials";
import type { FixtureFile } from "./fixture";
import { HubService } from "./service";
import type { Transport } from "./transport";

export const HUB_LIST = "desktop-hubs.json";
/** Where an unreadable list goes, kept for the person rather than overwritten. */
export const HUB_LIST_BAD = "desktop-hubs.json.bad";
/** The hubs found again from their keys when the list was lost: they have no name until the person gives one. */
export const RECOVERED_NOTE = `This app's list of hubs (${HUB_LIST}) couldn't be read, so its hubs were found again from their saved keys, without their names. The old list is kept as ${HUB_LIST_BAD}.`;

const Stored = z.object({ id: z.string().regex(HUB_ID), label: z.string().min(1).max(LABEL_MAX).optional(), color: z.enum(HUB_COLORS).optional() });
type Stored = z.infer<typeof Stored>;
const StoredList = z.object({ version: z.literal(1), hubs: z.array(Stored).min(1).max(50) });

export type HubsMode =
  | {
      readonly kind: "hub";
      /** The fleetd dir, where the keys and the list live. */
      readonly dir: string;
      readonly credentials: CredentialEnv;
      readonly vars: NodeJS.ProcessEnv;
      readonly transport: Transport;
      /** Where each hub's offline cache goes (userData). */
      readonly cacheDir: string;
    }
  | { readonly kind: "fixture"; readonly fixture: FixtureFile };

/** The first hub's cache keeps its old name. */
export const cacheFileName = (hub: HubId): string => (hub === FIRST_HUB ? "hub-cache.json" : `hub-cache-${hub}.json`);

/** The ids whose keys are saved in `dir` (credentials.ts names the files), the first hub's first. */
const savedIds = (dir: string): HubId[] => {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const ids = new Set<HubId>();
  if (names.includes("desktop-hub.bin") || names.includes("desktop-hub.json")) ids.add(FIRST_HUB);
  for (const name of names) {
    const id = /^desktop-hub-([a-z0-9]{1,16})\.(?:bin|json)$/u.exec(name)?.[1];
    if (id !== undefined) ids.add(id);
  }
  return [...ids];
};

/**
 * The list as saved; null when there is none (the app has its first hub alone). One that can't be read loses no hub:
 * it is kept aside as HUB_LIST_BAD, and the hubs are found again from their saved keys (`recovered`), unnamed.
 */
export const readHubList = (dir: string): { hubs: Stored[]; recovered: boolean } | null => {
  let text: string;
  try {
    text = readFileSync(join(dir, HUB_LIST), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = StoredList.safeParse(JSON.parse(text));
    if (parsed.success && new Set(parsed.data.hubs.map((h) => h.id)).size === parsed.data.hubs.length) return { hubs: parsed.data.hubs, recovered: false };
  } catch {
    // Not JSON: as unreadable as a list of the wrong shape.
  }
  try {
    renameSync(join(dir, HUB_LIST), join(dir, HUB_LIST_BAD));
  } catch {
    // Left where it is: the recovered list is written over it, the hubs themselves being safe.
  }
  const ids = savedIds(dir);
  console.warn(`${HUB_LIST} couldn't be read; found ${String(ids.length)} hubs again from their keys, and kept it as ${HUB_LIST_BAD}.`);
  return { hubs: (ids.length === 0 ? [FIRST_HUB] : ids).map((id) => ({ id })), recovered: true };
};

/** A new hub's id: never one in use, never one whose files are still there, never the first's. */
const newId = (taken: ReadonlySet<HubId>, dir: string | null): HubId => {
  const used = new Set([...taken, ...(dir === null ? [] : savedIds(dir)), FIRST_HUB]);
  for (;;) {
    const id = randomBytes(4).toString("hex");
    if (!used.has(id)) return id;
  }
};

/** Two addresses of the same hub, however typed (`devbox:4790`, `http://devbox:4790/`, `ws://devbox:4790/app`). */
const sameHub = (a: string, b: string): boolean => {
  const x = hubOrigin(a);
  const y = hubOrigin(b);
  return x.ok && y.ok && x.origin === y.origin;
};

export class Hubs {
  readonly #mode: HubsMode;
  /** FLEETD_HUB_URL + FLEETD_AGENT_KEY, or a fixture: nothing is saved. */
  readonly #ephemeral: boolean;
  #entries: Stored[];
  readonly #services = new Map<HubId, HubService>();
  readonly #listeners = new Set<(list: readonly HubEntry[]) => void>();
  /** Said beside each hub until the app quits, e.g. that the list was lost and its hubs found again. */
  #note: string | null = null;

  constructor(mode: HubsMode) {
    this.#mode = mode;
    if (mode.kind === "fixture") {
      this.#ephemeral = true;
      const { hubs = [], label, color, ...first } = mode.fixture;
      const files: Array<{ id: HubId; label?: string | undefined; color?: HubColor | undefined; fixture: FixtureFile }> = [
        { id: FIRST_HUB, label, color, fixture: { ...first, hubs: [] } },
        ...hubs.map((h, i) => ({ id: `h${String(i + 2)}`, label: h.label, color: h.color, fixture: h.fixture })),
      ];
      this.#entries = files.map(({ id, label: l, color: c }) => ({ id, ...(l === undefined ? {} : { label: l }), ...(c === undefined ? {} : { color: c }) }));
      for (const f of files) this.#services.set(f.id, new HubService({ kind: "fixture", id: f.id, fixture: f.fixture }));
      return;
    }
    const scripted = fromEnv(mode.vars);
    this.#ephemeral = scripted !== null;
    const saved = scripted === null ? readHubList(mode.dir) : null;
    this.#entries = saved?.hubs ?? [{ id: FIRST_HUB }];
    for (const { id } of this.#entries) {
      const loaded = scripted === null ? loadCredentials(mode.credentials, id) : { saved: scripted };
      this.#services.set(id, this.#service(id, loaded));
    }
    if (saved?.recovered === true) {
      this.#note = RECOVERED_NOTE;
      this.#save();
    }
  }

  #service(id: HubId, loaded: Loaded): HubService {
    if (this.#mode.kind !== "hub") throw new Error("a fixture's hubs are fixed");
    const { credentials, transport, cacheDir } = this.#mode;
    return new HubService({ kind: "hub", id, credentials, loaded, ephemeral: this.#ephemeral, transport, cache: new HubCacheFile(join(cacheDir, cacheFileName(id))) });
  }

  /** In sidebar order, each with its label: the person's, else its host name until they pick one. */
  list(): HubEntry[] {
    return this.#entries.map(({ id, label, color }) => {
      const url = this.#services.get(id)?.url() ?? null;
      return {
        id,
        label: label ?? (url === null ? "Hub" : defaultLabel(url)),
        ...(color === undefined ? {} : { color }),
        ...(this.#note === null ? {} : { note: this.#note }),
      };
    });
  }

  get(id: HubId): HubService | undefined {
    return this.#services.get(id);
  }

  all(): HubService[] {
    return [...this.#services.values()];
  }

  /** No hub has a key yet: app-pair.json may pair the first. */
  firstRun(): boolean {
    return this.all().every((s) => s.state().phase === "unpaired");
  }

  onChange(listener: (list: readonly HubEntry[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * A key for a hub: into the one `target` names, into a new hub under a label, or (no target) into the first, as
   * pairing did with one hub.
   */
  connect(request: { readonly url: string; readonly key: string }, target?: PairTarget): ConnectOutcome {
    if (target === undefined || "hub" in target) {
      const service = this.#services.get(target?.hub ?? this.#entries[0]?.id ?? FIRST_HUB);
      if (service === undefined) return { ok: false, message: "That hub was removed." };
      const outcome = service.connect(request);
      if (outcome.ok) this.#changed();
      return outcome;
    }
    const label = cleanLabel(target.label);
    if (label === null) return { ok: false, message: `Name the hub in 1 to ${String(LABEL_MAX)} characters.` };
    if (this.#mode.kind !== "hub") return this.all()[0]?.connect(request) ?? { ok: false, message: "Not available." };
    // A hub already listed (a pairing link for it, or its address typed again) is paired again, not added twice.
    const listed = this.#entries.find((e) => {
      const url = this.#services.get(e.id)?.url();
      return url !== undefined && url !== null && sameHub(url, request.url);
    });
    if (listed !== undefined) return this.connect(request, { hub: listed.id });
    // The one hub not paired yet (a fresh app's) takes the key rather than sitting beside the new one.
    const fresh = this.#entries.length === 1 && this.firstRun() ? this.#entries[0] : undefined;
    const id = fresh?.id ?? newId(new Set(this.#entries.map((e) => e.id)), this.#mode.dir);
    const service = this.#services.get(id) ?? this.#service(id, { saved: null });
    const outcome = service.connect(request);
    if (!outcome.ok) {
      if (fresh === undefined) service.stop();
      return outcome;
    }
    const entry: Stored = { id, label, ...(target.color === undefined ? {} : { color: target.color }) };
    this.#services.set(id, service);
    this.#entries = fresh === undefined ? [...this.#entries, entry] : [entry];
    return this.#save();
  }

  /** A new label or colour; null takes the colour away. */
  update(id: HubId, change: { readonly label: string; readonly color: HubColor | null }): ConnectOutcome {
    const label = cleanLabel(change.label);
    if (label === null) return { ok: false, message: `Name the hub in 1 to ${String(LABEL_MAX)} characters.` };
    if (!this.#entries.some((e) => e.id === id)) return { ok: false, message: "That hub was removed." };
    this.#entries = this.#entries.map((e) => (e.id === id ? { id, label, ...(change.color === null ? {} : { color: change.color }) } : e));
    return this.#save();
  }

  /** Forgets the hub's key and cache; the last one stays listed, not paired, for onboarding. */
  remove(id: HubId): void {
    const service = this.#services.get(id);
    if (service === undefined || this.#mode.kind !== "hub") return;
    service.forget();
    service.stop();
    this.#services.delete(id);
    this.#entries = this.#entries.filter((e) => e.id !== id);
    if (this.#entries.length === 0) {
      // The last one: a new hub, not paired, under an id of its own, so nothing kept for the old one carries over.
      const fresh = newId(new Set([id]), this.#mode.dir);
      this.#services.set(fresh, this.#service(fresh, { saved: null }));
      this.#entries = [{ id: fresh }];
    }
    this.#save();
  }

  /** This minute's presence to every hub; only the hub whose chat is on screen hears which project it is. */
  presence(frame: PresenceFrame): void {
    for (const service of this.all()) {
      const { project: _shown, ...rest } = frame;
      const project = service.onScreen();
      service.presence(project === null ? rest : { ...rest, project });
    }
  }

  windowFocused(): void {
    for (const service of this.all()) service.windowFocused();
  }

  systemResumed(): void {
    for (const service of this.all()) service.systemResumed();
  }

  stop(): void {
    for (const service of this.all()) service.stop();
  }

  #save(): ConnectOutcome {
    let outcome: ConnectOutcome = { ok: true };
    if (!this.#ephemeral && this.#mode.kind === "hub") {
      try {
        writePrivate(this.#mode.dir, HUB_LIST, JSON.stringify({ version: 1, hubs: this.#entries }));
      } catch (error) {
        outcome = { ok: false, message: `Couldn't save the list of hubs: ${String(error)}` };
      }
    }
    this.#changed();
    return outcome;
  }

  #changed(): void {
    const list = this.list();
    for (const listener of this.#listeners) listener(list);
  }
}
