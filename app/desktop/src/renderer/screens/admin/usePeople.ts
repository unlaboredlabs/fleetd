import { useToolQuery } from "../../src/data/react";
import { useLive } from "../settings/hub";

const noInput = {};

/** The hub's people, devices and open invites: one read, shared by People, its invites and Claude. */
export const usePeople = () => {
  const live = useLive();
  return useToolQuery("people_list", noInput, { enabled: live });
};
