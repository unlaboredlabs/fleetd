import type { ReactNode } from "react";
import { Button, Dialog, Select, Text } from "../../ui";
import { selectProjects } from "../../src/data/selectors";
import { useData } from "../../src/data/react";
import type { ProjectSummary } from "./contracts";
import { HUB, scopeKey, type Scope } from "./editor";
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
      return { value: key, label: same(p) ? `${p.title} on ${p.machineId}` : p.title };
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

/** Every Settings page's one title, with its one-line description and, beside it, a control for the whole page. */
export function PageHead(props: { title: string; children?: ReactNode; aside?: ReactNode }) {
  return (
    <header className={s.pageHead}>
      <div className={s.pageTitles}>
        <Text as="h1" size="xl" strong>
          {props.title}
        </Text>
        {props.children ? <Text tone="quiet">{props.children}</Text> : null}
      </div>
      {props.aside}
    </header>
  );
}
