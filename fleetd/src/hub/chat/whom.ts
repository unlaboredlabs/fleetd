// Whom a lead message, a card or a landing reaches (artifact threads-design, "Needs-you is per person"): the person
// its order belongs to, else the person the lead was answering, never just whoever wrote last. The hub stamps it on
// the message as `for`; needs-you, the badge and the push go by it.
import type { HumanRequest, PersonRef, ProjectRef, WorkstreamId } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { ownerOn, refOf } from "../people/store.ts";
import { parseMs } from "../store/time.ts";
import { aboutFor, orderFor, requestOrder } from "./about.ts";

/** The hub's owner, whom work no person started goes to. */
const owner = (hub: Hub): PersonRef | undefined => {
  const o = ownerOn(hub.db.conn);
  return o ? refOf(o) : undefined;
};

/** A lead message said at `atMs`: its turn's order's starter, else the person the turn answered. */
export const messageFor = (hub: Hub, r: ProjectRef, atMs: number): PersonRef | undefined => aboutFor(hub, r, atMs).for;

/** An order's landing or stop: its starter, else (an automation's, the train's) the owner. */
export const orderPerson = (hub: Hub, workstreamId: WorkstreamId): PersonRef | undefined => orderFor(hub, workstreamId) ?? owner(hub);

/**
 * A card (a command to approve, a secret to enter): its order's starter, else the owner; with no order, the person
 * the lead was answering when it opened, else the owner.
 */
export function requestFor(hub: Hub, request: HumanRequest): PersonRef | undefined {
  const order = requestOrder(hub, request);
  if (order !== undefined) return orderPerson(hub, order);
  return messageFor(hub, request.projectRef, parseMs(request.createdAt) ?? hub.clock.now()) ?? owner(hub);
}
