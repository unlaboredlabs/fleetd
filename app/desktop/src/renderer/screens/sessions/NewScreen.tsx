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
// opens on that page. A workspace with no bots yet gets a line that a screen needs one and New bot, the sidebar's
// dialog; once the bot is made and that dialog is done, the picker follows for it.
import { Plus } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { Button, Dialog, markShown, Text, Tooltip } from "../../ui";
import { useData } from "../../src/data/react";
import { selectProjects } from "../../src/data/selectors";
import { useCommands } from "../palette";
import { addUi, openAddProject, useAddState } from "../projects/store";
import { currentRoute } from "../shell/navigation";
import type { ProjectKey } from "../shell/routes";
import { NewScreenDialog } from "./NewScreenDialog";

/** The hub feature that says it opens people's screens. */
export const NEW_SCREEN = "screen_open";


const keyOf = (p: ProjectKey) => `${p.machineId}/${p.projectId}`;

// What the picker is open for, if it is: a project's, or the Screens page's for any bot. One picker for the window.
// `making`: no bot yet, so New bot is making the first one, and the picker waits for it. It holds New bot's create
// count when it opened, so a dialog closed after a create (made, its bot not listed yet) is told from one cancelled.
type Shown = { readonly project?: ProjectKey; readonly making?: number };
let shown: Shown | null = null;
const listeners = new Set<() => void>();
const set = (to: Shown | null) => {
  shown = to;
  for (const l of listeners) l();
};

/**
 * Opens the picker for `project`, or with no project (the Screens page) for any bot, picked first. On the web its host
 * mounts once the app has shown (PaletteHost), which a page with no chat (a workspace with no bots) never says: a
 * press is past the first screen, so it says so and the picker shows at once, not up to 30 s later.
 */
export const openNewScreen = (project?: ProjectKey): void => {
  markShown();
  set(project === undefined ? {} : { project });
};

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
  const add = useAddState();
  const making = open?.making;
  // New bot closed without a create: nothing to follow.
  const dropped = making !== undefined && !add.open && add.add.phase.kind === "form" && add.add.gen === making;
  useEffect(() => {
    if (dropped) set(null);
  }, [dropped]);
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
  if (first === undefined) {
    if (projects === undefined || making !== undefined) return null;
    const make = () => {
      openAddProject();
      set({ making: addUi().add.gen });
    };
    return <NoBot onMake={make} onClose={() => set(null)} />;
  }
  // The bot just made: its dialog may stay to show its repos coming in; the picker follows once it is done.
  if (making !== undefined && add.open) return null;
  const project = { machineId: first.machineId, projectId: first.projectId };
  return <NewScreenDialog key={open.project === undefined ? "any" : keyOf(project)} project={project} anyBot={open.project === undefined} onClose={() => set(null)} />;
}

/** A workspace with no bots: a screen needs one, and New bot makes it. */
function NoBot({ onMake, onClose }: { onMake: () => void; onClose: () => void }) {
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="New screen"
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={<Plus aria-hidden />} onClick={onMake}>
            New bot
          </Button>
        </>
      }
    >
      <div data-screen="sessions.new.nobot">
        <Text as="p" size="sm">
          A screen opens for a bot, and this workspace has none yet. Make one, then pick its screen.
        </Text>
      </div>
    </Dialog>
  );
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

