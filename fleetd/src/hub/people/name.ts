// A person's own name (`person_name_set`): what the apps and the leads call them. Only a person changes their own, from
// one of their devices, whatever their role; an owner or admin renames someone else with person_set. The name is
// cleaned as an invite's is (`cleanName`), and an empty one is refused.
//
// A change is the same `people.changed` event person_set's rename is (`renamed`), which sends every open app back to
// hub_info and people_list. What they did before keeps the name they had then.
import type { Person, PersonNameSetInput } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { me } from "./avatar.ts";
import { announce, change } from "./events.ts";
import { cleanName } from "./roles.ts";
import { people, refOf } from "./store.ts";

export function register(tools: Registry): void {
  tools.add("person_name_set", (hub, caller, input) => set(hub, caller, input));
}

const NOT_YOURS = {
  message: "Only a person changes their own name, from one of their own devices.",
  fix: "Change it in the app's Settings; an owner or admin renames someone else with person_set.",
};

function set(hub: Hub, caller: Caller, input: PersonNameSetInput): { person: Person } {
  const person = me(hub, caller, NOT_YOURS);
  const name = cleanName(input.name);
  if (name === undefined) throw new ToolError("invalid", "The name is empty.", "Type the name you go by.");
  const after = people(hub).set(person.personId, name, undefined) ?? person;
  // The same name again changes nothing and says nothing.
  if (after.name !== person.name) {
    announce(hub, change("renamed", refOf(after), refOf(after)), `${person.name} changed their name to ${after.name}`);
  }
  return { person: after };
}
