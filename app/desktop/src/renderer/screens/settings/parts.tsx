import type { ReactNode } from "react";
import { Button, Dialog, FrameTitle, Select, Text } from "../../ui";
import { selectProjects } from "../../src/data/selectors";
import { useData } from "../../src/data/react";
import type { ProjectSummary } from "./contracts";
import { HUB, scopeKey, type Scope } from "./editor";
import { isArchived } from "../projects/model";
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

/** Hub-wide (when `hubWide` names it) or one project; a project not in the list still shows by its id. */
export function ScopeSelect(props: {
  id: string;
  value: Scope | null;
  hubWide?: string;
  /** Undefined while loading: the picker is disabled and says so. */
  projects: ReadonlyArray<ProjectSummary> | undefined;
  onChange: (scope: Scope) => void;
  className?: string | undefined;
}) {
  const projects = props.projects ?? [];
  const loading = props.projects === undefined;
  const same = (p: ProjectSummary) => projects.filter((q) => q.title === p.title).length > 1;
  const options = [
    ...(props.hubWide ? [{ value: "hub", label: props.hubWide }] : []),
    ...projects.map((p) => {
      const key = `${p.machineId}/${p.projectId}`;
      // Two projects can share a title (one repo on two machines); the machine tells them apart.
      const label = same(p) ? `${p.title} on ${p.machineId}` : p.title;
      // An archived one is out of the sidebar: here is where it comes back.
      return { value: key, label: isArchived(p) ? `${label} (archived)` : label };
    }),
  ];
  const value = props.value ? scopeKey(props.value) : undefined;
  if (value !== undefined && !options.some((o) => o.value === value) && props.value?.kind === "project") {
    options.push({ value, label: props.value.ref.projectId });
  }
  return (
    <Select
      id={props.id}
      {...(props.className ? { className: props.className } : {})}
      value={loading ? undefined : value}
      placeholder={loading ? "Loading…" : "Pick a project"}
      disabled={loading}
      options={options}
      onValueChange={(v) => {
        if (v === "hub") return props.onChange(HUB);
        const [machineId = "", projectId = ""] = v.split("/");
        props.onChange({ kind: "project", ref: { machineId, projectId } });
      }}
    />
  );
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
 * Every Settings page's title, in the window's top row like every page's. Its one-line description opens the page,
 * with a control for the whole page beside it (a full-size field, too tall for the top row).
 */
export function PageHead(props: { title: string; children?: ReactNode; aside?: ReactNode }) {
  return (
    <>
      <FrameTitle title={props.title} />
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
  return <Text tone="quiet">{projects === undefined ? "Loading…" : "No projects yet. Add one from Projects in the sidebar."}</Text>;
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
