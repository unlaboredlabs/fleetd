// A person's own picture (`person_avatar_set`, `person_avatar_get`): what the
// apps show in place of their initials. It is kept as a project's picture is (projects/avatar.ts, whose `render` and
// its worker it uses): the crop, upright, at most AVATAR_PX a side, re-encoded as JPEG with none of the original's
// metadata, and the upload forgotten at once. Only a person sets their own, from one of their devices; anyone on the
// hub reads it.
//
// A person names the picture by `avatar`, its sha256's first 16 hex, so an app fetches its bytes once per picture; a
// change is a `people.changed` event, which sends every open app back to hub_info and people_list.
import type { Person, PersonAvatarSetInput, ProjectAvatarGetOutput } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { isHuman } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { take } from "../intake/attachments.ts";
import { render } from "../projects/avatar.ts";
import { announce, change } from "./events.ts";
import { people, refOf } from "./store.ts";

export function register(tools: Registry): void {
  tools.add("person_avatar_set", (hub, caller, input) => set(hub, caller, input));
  tools.add("person_avatar_get", (hub, _caller, input) => get(hub, input.personId));
}

/** The caller's own person, still on the hub; anyone else (an agent, a lead, a key of no one) is refused as `refusal` says. */
export function me(hub: Hub, caller: Caller, refusal: { message: string; fix: string }): Person {
  const person = isHuman(caller) && caller.person !== undefined ? people(hub).get(caller.person.personId) : undefined;
  if (person && person.removedAt === undefined) return person;
  throw new ToolError("forbidden", refusal.message, refusal.fix);
}

const NOT_YOURS = {
  message: "Only a person sets their own picture, from one of their own devices.",
  fix: "Tap your picture in the phone app's Settings.",
};

async function set(hub: Hub, caller: Caller, input: PersonAvatarSetInput): Promise<{ person: Person }> {
  const person = me(hub, caller, NOT_YOURS);
  const id = person.personId;
  if (input.attachmentId !== undefined) {
    const { bytes } = await take(hub, caller, input.attachmentId);
    const jpeg = await render(bytes, input.crop);
    const avatar = new Bun.CryptoHasher("sha256").update(jpeg).digest("hex").slice(0, 16);
    hub.db.conn
      .query(
        `INSERT INTO person_avatars (person_id, avatar, jpeg, set_ms) VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT (person_id) DO UPDATE SET avatar = excluded.avatar, jpeg = excluded.jpeg,
                       set_ms = excluded.set_ms`,
      )
      .run(id, avatar, jpeg, hub.clock.now());
  } else {
    hub.db.conn.query("DELETE FROM person_avatars WHERE person_id = ?1").run(id);
  }
  const after = people(hub).get(id) ?? person;
  announce(
    hub,
    change("picture_changed", refOf(after), refOf(after)),
    after.avatar !== undefined ? `${after.name} has a new picture` : `${after.name} removed their picture`,
  );
  return { person: after };
}

function get(hub: Hub, personId: string): ProjectAvatarGetOutput {
  const kept = hub.db.conn
    .query<{ avatar: string; jpeg: Uint8Array }, [string]>("SELECT avatar, jpeg FROM person_avatars WHERE person_id = ?1")
    .get(personId);
  if (!kept) {
    throw new ToolError("not_found", `${personId} has no picture.`, "Their initials show; they set one with person_avatar_set.");
  }
  return { avatar: kept.avatar, mime: "image/jpeg", dataB64: Buffer.from(kept.jpeg).toString("base64") };
}
