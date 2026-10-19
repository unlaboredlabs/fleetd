// Mounted once by the shell: the palette's "Add project…" and its machines, and a folder or a GitHub link dropped
// anywhere on the window (a link dragged out of a browser works too). The composer takes files it can attach first:
// a drop it handled arrives here with defaultPrevented.

import { useEffect, useMemo, useState } from "react";
import { Text } from "../../ui";
import { useCommands, useSource, type Command, type Source } from "../palette";
import { getFleet, onHubFrame } from "./fleet";
import { machineParts } from "./machineText";
import { githubRepo, linkUrl, otherHost, tilde } from "./source";
import { localMachine, openAddProject, type Note } from "./store";
import s from "./projects.module.css";

const machinesSource: Source = {
  id: "projects.machines",
  items: (): ReadonlyArray<Command> => {
    const f = getFleet();
    const now = Date.now() + f.skewMs;
    return f.machines.map((m) => ({
      id: `machine:${m.machineId}`,
      title: m.name,
      detail: machineParts(m, f.machineLive.get(m.machineId), now).map((p) => p.text).join(" · ") || m.status,
      group: "machines",
      keywords: m.tags,
      run: () => {
        window.location.hash = "#/machines";
      },
    }));
  },
  subscribe: (onChange) => onHubFrame((frame) => {
    if (frame.t === "snapshot" || frame.t === "event") onChange();
  }),
};

/** What a drop means for Add project, or null when it is nothing it can use. */
const fromDrop = async (data: DataTransfer): Promise<{ text: string; note?: Note } | null> => {
  const file = data.files[0];
  const path = file ? window.fleetd.projects.pathForFile(file) : "";
  if (path !== "") {
    const info = await window.fleetd.projects.readDrop(path);
    if (info.kind === "missing") return { text: "", note: { text: `${tilde(path)} isn't there any more.`, problem: true } };
    if (info.kind === "file") {
      const repo = info.link === undefined ? null : githubRepo(info.link);
      if (info.link !== undefined && repo !== null) return { text: info.link, note: { text: `From ${path.split(/[\\/]/u).pop() ?? path}.`, problem: false } };
      return { text: "", note: { text: "That file has no GitHub link in it. Drop a repo's folder, or a link to it on GitHub.", problem: true } };
    }
    const local = localMachine();
    if (local) {
      const note = info.git
        ? `A folder on this computer, which is ${local.name}.`
        : `${tilde(path)} isn't a git checkout yet: run git init there first, or pick its repo's folder.`;
      return { text: path, note: { text: note, problem: !info.git } };
    }
    const repo = info.origin === undefined ? null : githubRepo(info.origin);
    if (repo !== null) {
      return { text: repo, note: { text: `This computer isn't one of your machines, so the fleet clones ${repo} from GitHub instead.`, problem: false } };
    }
    return {
      text: "",
      note: {
        text: `${tilde(path)} is on this computer, which isn't one of your machines, and it has no GitHub remote. Push it to GitHub and paste its URL, or add this computer with fleetd machine add --local.`,
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

const accepts = (data: DataTransfer | null): boolean =>
  data !== null && (data.types.includes("Files") || data.types.includes("text/uri-list") || data.types.includes("text/plain"));

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
  useSource(machinesSource);

  useEffect(() => {
    // Counts nested enter/leave pairs so moving over child elements doesn't flicker the overlay.
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!accepts(e.dataTransfer)) return;
      depth += 1;
      setOver(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setOver(false);
    };
    const overHandler = (e: DragEvent) => {
      if (e.defaultPrevented || !accepts(e.dataTransfer)) return;
      // Without this the drop navigates the window to the file or link.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const drop = (e: DragEvent) => {
      depth = 0;
      setOver(false);
      const data = e.dataTransfer;
      if (e.defaultPrevented || data === null) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
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
