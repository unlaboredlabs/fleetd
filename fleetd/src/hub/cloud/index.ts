// What the hub does for its cloud machines once they join: whether a machine
// is ready for work (caught up since its node last linked), and the pool checkouts being cloned.
import type { Hub } from "../api/hub.ts";
import { executors } from "../executor/index.ts";
import { Cloning } from "../pool/place.ts";
import { isPool } from "./outbox.ts";

export class Cloud {
  private readonly caughtUp = new Map<string, number>();
  readonly cloning = new Cloning();

  constructor(private readonly hub: Hub) {}

  /** The catch-up of the link that went live at `liveSince` is done. */
  setCaughtUp(machineId: string, liveSince: number): void {
    this.caughtUp.set(machineId, liveSince);
  }

  /** Whether work may be placed on the machine: any machine but a cloud one at once; a cloud one once caught up. */
  ready(machineId: string): boolean {
    if (!isPool(this.hub, machineId)) return true;
    const live = executors(this.hub).liveSince(machineId);
    return live !== undefined && this.caughtUp.get(machineId) === live;
  }
}

/** The hub's cloud machines, `hub.area("cloud")`. */
export const cloud = (hub: Hub) => hub.area("cloud", (h) => new Cloud(h));
