// The names the hub's people go by now, by person id (people_list, read again on every people.changed). A chat message
// keeps its writer's name as it was when they wrote it (PersonRef), so a chat and the sidebar's line under it look the
// writer up here: someone who changed their name shows under the new one on what they wrote before, at once. The
// message's own name stands for someone removed from the hub, and on a hub that doesn't list its people.
import { useMemo } from "react";
import { useToolQuery } from "../../src/data/react";

export type PersonNames = ReadonlyMap<string, string>;

const noInput = {};

export const namesOf = (people: ReadonlyArray<{ readonly personId: string; readonly name: string }> | undefined): PersonNames =>
  new Map((people ?? []).map((p) => [p.personId, p.name]));

/** The name `person` goes by now; the one they had then when the hub no longer lists them. */
export const nameNow = (person: { readonly personId: string; readonly name: string }, names: PersonNames | undefined): string =>
  names?.get(person.personId) ?? person.name;

export const usePersonNames = (): PersonNames => {
  const people = useToolQuery("people_list", noInput, { keepPrevious: true }).data?.people;
  return useMemo(() => namesOf(people), [people]);
};
