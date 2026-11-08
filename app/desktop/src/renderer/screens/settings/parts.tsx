import { createContext, useContext, type ReactNode } from "react";
import { Button, Dialog, FrameTitle, Text } from "../../ui";
import { selectProjects } from "../../src/data/selectors";
import { useData } from "../../src/data/react";
import type { ProjectSummary } from "./contracts";
import type { Scope } from "./editor";
import { navigate } from "../shell/navigation";
import { useReveal } from "./search";
import s from "./settings.module.css";

/** The hub's projects, for the pickers: the snapshot's, kept current by the data layer. Undefined until the
 * connection is fresh (not an empty list: an empty hub and one still loading must not look alike). */
export const useProjects = (): ReadonlyArray<ProjectSummary> | undefined => useData(selectProjects);

export function scopeName(scope: Scope, projects: ReadonlyArray<ProjectSummary> | undefined): string {
  if (scope.kind === "hub") return "Hub-wide";
  const p = projects?.find((x) => x.machineId === scope.ref.machineId && x.projectId === scope.ref.projectId);
  return p?.title ?? scope.ref.projectId;
}

/** Asks before a switch drops unsaved edits. */
export function ConfirmDiscard(props: { open: boolean; what: string; why: string; onKeep: () => void; onDiscard: () => void }) {
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => !open && props.onKeep()}
      title={`Discard your changes to ${props.what}?`}
      description={`They aren't saved. ${props.why}`}
      footer={
        <>
          <Button onClick={props.onKeep}>Keep editing</Button>
          <Button variant="danger" onClick={props.onDiscard}>
            Discard changes
          </Button>
        </>
      }
    />
  );
}

/**
 * The pages a set of tabs gathers (a project's, Every project's): the set's name and way back stand in the window's top
 * row for each page's own title, which its tab already says.
 */
export const PageFrame = createContext<{ title: string; lead?: ReactNode } | null>(null);

/**
 * Every Settings page's title, in the window's top row like every page's. Its one-line description opens the page,
 * with a control for the whole page beside it (a full-size field, too tall for the top row).
 */
export function PageHead(props: { title: string; children?: ReactNode; aside?: ReactNode }) {
  const frame = useContext(PageFrame);
  return (
    <>
      <FrameTitle title={frame?.title ?? props.title} lead={frame?.lead} />
      {props.children || props.aside ? (
        <div className={s.pageIntro}>
          {props.children ? <Text tone="quiet">{props.children}</Text> : null}
          {props.aside}
        </div>
      ) : null}
    </>
  );
}

/**
 * One part of a page that gathers several (Your accounts, Tools & skills, General's Notifications): its heading and a line,
 * then its options. A search or a link for `reveal` lands on it; a part that search finds by an option inside it names
 * itself with `part` instead, so one place is one search result. `untitled` when it is the page's one part, which the
 * page title already names.
 */
export function PagePart(props: { title: string; reveal?: string; part?: string; intro?: ReactNode; aside?: ReactNode; untitled?: boolean; children?: ReactNode }) {
  const ref = useReveal<HTMLElement>(props.reveal ?? "");
  return (
    <section ref={ref} className={s.part} aria-label={props.title} data-part={props.reveal ?? props.part} tabIndex={-1}>
      <div className={s.partHead}>
        <div className={s.partTitle}>
          {props.untitled === true ? null : (
            <Text as="h2" size="lg" strong>
              {props.title}
            </Text>
          )}
          {props.aside}
        </div>
        {props.intro ? (
          <Text size="sm" tone="quiet">
            {props.intro}
          </Text>
        ) : null}
      </div>
      {props.children}
    </section>
  );
}

/** In place of a project's page while the hub has no project. */
export function NoProject() {
  const projects = useProjects();
  if (projects === undefined) return <Text tone="quiet">Loading…</Text>;
  return (
    <div className={s.inline}>
      <Text tone="quiet">No projects yet.</Text>
      <Button size="sm" onClick={() => navigate({ id: "projects.add" })}>
        New project
      </Button>
    </div>
  );
}

/**
 * One option: its name and a line of help, then its controls. A settings search for `reveal` lands on it; one without
 * is found by the part it is in.
 */
export function Setting(props: { reveal?: string; label: string; help?: string; children: ReactNode }) {
  const ref = useReveal<HTMLElement>(props.reveal ?? "");
  return (
    <section ref={ref} className={s.setting} aria-label={props.label} tabIndex={-1}>
      <div className={s.settingLabel}>
        <Text strong>{props.label}</Text>
        {props.help === undefined ? null : (
          <Text size="xs" tone="quiet">
            {props.help}
          </Text>
        )}
      </div>
      <div className={s.stack}>{props.children}</div>
    </section>
  );
}
