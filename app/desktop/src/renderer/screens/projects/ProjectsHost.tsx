// Mounted once by the shell: the palette's "Add project…" and its machines, and a folder or a GitHub link dropped
// anywhere on the window, a lead chat included (a link dragged out of a browser works too). Files dropped on a chat
// are its composer's (see dropOwner); any other file is ignored, never turned into an Add project.

import { useEffect, useMemo, useState } from "react";
import { Text } from "../../ui";
import { useCommands, useSource, type Command, type Source } from "../palette";
import type { DataLayer } from "../../src/data/queries";
import { useDataLayer } from "../../src/data/react";
import { hubNow, selectMachines } from "../../src/data/selectors";
import { machineParts } from "./machineText";
import { githubRepo, linkUrl, otherHost, tilde } from "./source";
import { localMachine, openAddProject, type Note } from "./store";
import s from "./projects.module.css";

/** The palette's machines, read from the data layer's store while the palette is open. */
const machinesSource = (layer: DataLayer): Source => ({
  id: "projects.machines",
  items: (): ReadonlyArray<Command> => {
    const d = layer.store.getState();
    const now = hubNow(d, Date.now());
    return (selectMachines(d) ?? []).map(({ machine: m, live }) => ({
      id: `machine:${m.machineId}`,
      title: m.name,
      detail: machineParts(m, live, now).map((p) => p.text).join(" · ") || m.status,
      group: "machines",
      run: () => {
        window.location.hash = `#/settings/hub/machines/${m.machineId}`;
      },
    }));
  },
  subscribe: (onChange) => layer.store.subscribe((next, prev) => {
    if (next.machines !== prev.machines || next.live.machines !== prev.live.machines) onChange();
  }),
});

/** What a drop means for Add project, or null when it is nothing it can use. */
const fromDrop = async (data: DataTransfer): Promise<{ text: string; note?: Note } | null> => {
  const file = data.files[0];
  if (file) {
    const info = await window.fleetd.projects.readDrop(file);
    // An image, a document: not a project, so nothing happens.
    if (info.kind === "other") return null;
    if (info.kind === "link") return { text: info.repo, note: { text: `From ${file.name}.`, problem: false } };
    const local = localMachine();
    if (local) {
      const note = info.git
        ? `A folder on this computer, which is ${local.name}.`
        : `${tilde(info.path)} isn't a git checkout yet: run git init there first, or pick its repo's folder.`;
      return { text: info.path, note: { text: note, problem: !info.git } };
    }
    if (info.repo !== undefined) {
      return { text: info.repo, note: { text: `This computer isn't one of your machines, so the fleet clones ${info.repo} from GitHub instead.`, problem: false } };
    }
    return {
      text: "",
      note: {
        text: `${tilde(info.path)} is on this computer, which isn't one of your machines, and it has no GitHub remote. Push it to GitHub and paste its URL, or add this computer with fleetd machine add --local.`,
        problem: true,
      },
    };
  }
  const text = data.getData("text/uri-list").split("\n").find((l) => l.trim() !== "" && !l.startsWith("#")) ?? data.getData("text/plain");
  const t = text.trim();
  if (t === "") return null;
  const link = linkUrl(t) ?? (githubRepo(t) !== null ? t : null);
  if (link !== null) return { text: link };
  const other = otherHost(t);
  return other === null ? null : { text: t, note: { text: other, problem: true } };
};

export type DropOwner = "taken" | "field" | "projects";

/**
 * Who handles a drop. A lead chat's composer listens on the document, before this window listener, and attaches
 * the files dropped on the chat (that drop arrives here already defaultPrevented: "taken"). It passes folders and
 * links on, so a folder or a GitHub link opens Add project anywhere, chat included. A text field takes dropped
 * text (never files: one would open in the window).
 */
export const dropOwner = (drop: { readonly taken: boolean; readonly inField: boolean; readonly hasFiles: boolean }): DropOwner =>
  drop.taken ? "taken" : drop.inField && !drop.hasFiles ? "field" : "projects";

const ownerOf = (e: DragEvent): DropOwner => {
  const el = e.target instanceof Element ? e.target : null;
  return dropOwner({
    taken: e.defaultPrevented,
    inField: el instanceof HTMLElement && (el.isContentEditable || el.closest("input, textarea, [contenteditable='true']") !== null),
    hasFiles: e.dataTransfer?.types.includes("Files") === true,
  });
};

/** Media and documents are never a project; a folder (no MIME type), a link file or a link may be. */
const NOT_A_PROJECT = /^(?:image|video|audio)\/|^application\/pdf$/u;

/**
 * Whether a drag may be something Add project takes, from what a drag tells before the drop: the item kinds and
 * their MIME types. Only a drag of nothing but media and documents is ruled out, so the overlay doesn't promise an
 * Add project for an image.
 */
export const mayBeProject = (types: ReadonlyArray<string>, files: ReadonlyArray<{ readonly kind: string; readonly type: string }>): boolean => {
  if (types.includes("text/uri-list") || (types.includes("text/plain") && !types.includes("Files"))) return true;
  if (!types.includes("Files")) return false;
  const items = files.filter((i) => i.kind === "file");
  return items.length === 0 || items.some((i) => !NOT_A_PROJECT.test(i.type));
};

const accepts = (data: DataTransfer | null): boolean =>
  data !== null && mayBeProject([...data.types], [...data.items].map((i) => ({ kind: i.kind, type: i.type })));

export function ProjectsHost() {
  const [over, setOver] = useState(false);

  const commands = useMemo<ReadonlyArray<Command>>(
    () => [
      {
        // Overrides the palette's default with one that keeps a running add and returns where it came from.
        id: "go:projects.add",
        title: "Add project…",
        detail: "Clone a GitHub repo onto a machine, or add a folder already on one",
        group: "actions",
        keywords: ["new project", "clone", "repo", "github", "folder"],
        run: () => openAddProject(),
      },
    ],
    [],
  );
  useCommands(commands, []);
  const layer = useDataLayer();
  useSource(useMemo(() => machinesSource(layer), [layer]));

  useEffect(() => {
    // Counts nested enter/leave pairs so moving over child elements doesn't flicker the overlay.
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (ownerOf(e) !== "projects" || !accepts(e.dataTransfer)) return;
      depth += 1;
      setOver(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setOver(false);
    };
    const overHandler = (e: DragEvent) => {
      if (ownerOf(e) !== "projects") return;
      // A file Add project won't take must still never open in the window.
      if (!accepts(e.dataTransfer)) {
        if (e.dataTransfer?.types.includes("Files") === true) e.preventDefault();
        return;
      }
      // Without this the drop navigates the window to the file or link.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const drop = (e: DragEvent) => {
      depth = 0;
      setOver(false);
      if (ownerOf(e) !== "projects") return;
      const data = e.dataTransfer;
      e.preventDefault();
      if (data === null) return;
      // A folder or a GitHub link opens Add project; anything else (an image beside the composer) is ignored.
      void fromDrop(data).then((prefill) => {
        if (prefill === null) return;
        openAddProject(prefill);
      });
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", overHandler);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", overHandler);
      window.removeEventListener("drop", drop);
    };
  }, []);

  return over ? (
    <div className={s.dropOverlay} aria-hidden>
      <Text size="lg" strong>
        Drop a folder or a GitHub link to add it as a project
      </Text>
    </div>
  ) : null;
}
