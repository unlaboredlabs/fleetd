// Whether this app's person sees Administration: the sidebar's entry, the palette's command and the page itself ask
// here. Small and in the shell's chunk; the page is its own.
import { useToolQuery } from "../../src/data/react";
import { administers } from "./model";

const noInput = {};

/** False until hub_info answers, so a member never sees the entry flash in. */
export const useAdministers = (): boolean => administers(useToolQuery("hub_info", noInput).data);
