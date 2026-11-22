// New screen (D239): a person opens a browser, an iPhone simulator (D652), an Android emulator, a Linux desktop or the
// agents' Mac's screen, for a project. A short picker: the kind, as tiles, then its picks, each a quiet label over its
// control: the machine that can host it, each with its slots in words (a full one offers to wait for its next slot,
// which goes to people before agents); an iPhone's model and OS, from the simulators the Mac reports; an Android's PR
// build. It opens in the panel's live view with the person in control; a wait shows in the Screens list until its
// screen opens.
//
// A PR, optionally: an Android screen takes its CI build, which the hub installs before the person gets it. That goes
// on in the hub (a slow emulator can take minutes): the picker follows it from the Screens list's row and lands
// in the live view once the screen is theirs; closed meanwhile, the row shows in Screens until then. Opened from the top
// of the Screens tab and from the palette's "New screen…".
//
// Opened, it lands in its live view at once: the hub's answer goes into the Screens list before the view mounts, so the
// view watches its frames from its first render. An answer without the screen (a hub that answers before it has it)
// is followed in the list, as browser.session events read it again, until the person's new screen shows; only past
// FOLLOW_MS does the picker give up and land on the list. While an open is slow, the footer says what is starting.
//
// A kind no machine can host stays pickable: its tile says why in a word or two, and picked, the machine list gives way
// to the reason from the machines' nodes and its one fix. An admin's is a button to the place in Settings › Hub ›
// Machines that fixes it (there is no switch per kind to turn on); a member's says who to ask.
//
// At rest it is the title, the tiles, the machine and Open (W796): no explaining lines. When it ends (the machine's idle
// timeout) and a PR build going in first are a hover on Open; the browser's profile (saved sign-ins, or a fresh one
// while the bot's is in use) is its tile's line.
//
// The Screens page opens the same picker, for any bot: its first pick is then the bot, and a screen opened from there
// opens on that page.
import { Plus } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Button, Tooltip } from "../../ui";
import { useData } from "../../src/data/react";
import { selectProjects } from "../../src/data/selectors";
import { useCommands } from "../palette";
import { currentRoute } from "../shell/navigation";
import type { ProjectKey } from "../shell/routes";
import { NewScreenDialog } from "./NewScreenDialog";

/** The hub feature that says it opens people's screens. */
export const NEW_SCREEN = "screen_open";


const keyOf = (p: ProjectKey) => `${p.machineId}/${p.projectId}`;

// What the picker is open for, if it is: a project's, or the Screens page's for any bot. One picker for the window.
let shown: { readonly project?: ProjectKey } | null = null;
const listeners = new Set<() => void>();
const set = (to: { readonly project?: ProjectKey } | null) => {
  shown = to;
  for (const l of listeners) l();
};

/** Opens the picker for `project`, or with no project (the Screens page) for any bot, picked first. */
export const openNewScreen = (project?: ProjectKey): void => set(project === undefined ? {} : { project });

const subscribe = (onChange: () => void) => {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
};

/** The project on screen, if the route has one. */
const routeProject = (): ProjectKey | undefined => {
  const r = currentRoute();
  return r.id === "project" || r.id === "session" ? r.project : undefined;
};

/** Mounted once, beside the palette: the picker when it is open, and the palette's "New screen…". */
export function NewScreenHost() {
  const open = useSyncExternalStore(subscribe, () => shown);
  const projects = useData(selectProjects);
  const served = useData((d) => d.features.includes(NEW_SCREEN));
  useCommands(
    [
      {
        id: "screen.new",
        title: "New screen…",
        detail: "Open a browser, an iPhone, an Android, a desktop or the agents’ Mac’s screen, for this bot",
        group: "actions",
        keywords: ["browser", "iphone", "ios", "simulator", "ipad", "android", "emulator", "linux", "desktop", "mac", "session"],
        enabled: () => served && routeProject() !== undefined,
        run: () => {
          const p = routeProject();
          if (p !== undefined) openNewScreen(p);
        },
      },
    ],
    [served],
  );
  if (open === null) return null;
  // From the Screens page: any bot, the first one picked to start with.
  const first = open.project ?? projects?.[0];
  if (first === undefined) return null;
  const project = { machineId: first.machineId, projectId: first.projectId };
  return <NewScreenDialog key={open.project === undefined ? "any" : keyOf(project)} project={project} anyBot={open.project === undefined} onClose={() => set(null)} />;
}

/** New screen, a plus at the end of the Agents tab's Screens label. */
export function NewScreenButton({ project }: { project: ProjectKey }) {
  const served = useData((d) => d.features.includes(NEW_SCREEN));
  if (!served) return null;
  return (
    <Tooltip content="New screen: a browser or a device of your own, for this bot">
      <Button variant="quiet" size="sm" iconOnly aria-label="New screen" onClick={() => openNewScreen(project)}>
        <Plus />
      </Button>
    </Tooltip>
  );
}

