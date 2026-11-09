// What every area of the hub shares: one per hub, passed to every handler.
import type { Clock } from "../../shared/clock.ts";
import { Auth } from "../auth/index.ts";
import type { HubDb } from "../store/db.ts";

/** Where the hub listens: `--listen host:port`, default 127.0.0.1:4790. */
export type Listen = { host: string; port: number };

export type HubConfig = {
  /** `--home`, default `~/.fleetd/hub`. */
  home: string;
  listen: Listen;
  /** The hub's public URL when `fleetd init --url` set one; absent means `http://<listen>`. */
  url?: string;
};

export class Hub {
  readonly auth: Auth;
  /** Aborts once when the hub stops (SIGTERM/SIGINT); loops and long-lived sockets listen on it. */
  readonly shutdown = new AbortController();
  private readonly areas = new Map<string, unknown>();

  constructor(
    readonly config: HubConfig,
    readonly db: HubDb,
    readonly clock: Clock,
  ) {
    this.auth = new Auth(db, clock);
  }

  url(): string {
    return this.config.url ?? `http://${this.config.listen.host}:${this.config.listen.port}`;
  }

  /**
   * An area's service, made on first use and kept for the hub's life: `hub.area("train", (hub) => new Train(hub))`.
   * Areas keep their state here rather than in fields of Hub, so no two writers edit one file to add theirs.
   */
  area<T>(name: string, make: (hub: Hub) => T): T {
    if (!this.areas.has(name)) this.areas.set(name, make(this));
    return this.areas.get(name) as T;
  }

  /**
   * An area its owner already made, or undefined; never makes one (D355). For a consumer whose owner's module isn't in
   * the build yet: read it at each use, so it finds the area as soon as the owner makes it.
   */
  peek<T>(name: string): T | undefined {
    return this.areas.get(name) as T | undefined;
  }
}
