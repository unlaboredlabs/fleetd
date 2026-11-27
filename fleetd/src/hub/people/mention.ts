// How fleetd names a person in a line of its own, for the hub and the cloud alike: no store, no hub.
import type { PersonRef } from "../../shared/contracts.ts";

/**
 * A person named in a line fleetd writes in a chat, as a mention: `[Ada Park](person:p_1)`. The apps show it as the name
 * alone and never read an id in it as one of fleetd's (shared/refs.ts): "Check T6168" is a person, not an agent.
 */
export const mention = (p: PersonRef): string => `[${p.name.replace(/\s+/gu, " ").replace(/[\\[\]]/gu, "\\$&")}](person:${p.personId})`;
