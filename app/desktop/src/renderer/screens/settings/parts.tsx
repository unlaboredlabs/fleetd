import { Button, Dialog, Select } from "../../ui";
import { selectProjects } from "../../src/data/selectors";
import { useData } from "../../src/data/react";
import type { ProjectSummary } from "./contracts";
import { HUB, scopeKey, type Scope } from "./editor";

const none: ReadonlyArray<ProjectSummary> = [];

/** The hub's projects, for the pickers: the snapshot's, kept current by the data layer. */
export const useProjects = (): ReadonlyArray<ProjectSummary> => useData(selectProjects) ?? none;

export function scopeName(scope: Scope, projects: ReadonlyArray<ProjectSummary>): string {
  if (scope.kind === "hub") return "Hub-wide";
  const p = projects.find((x) => x.machineId === scope.ref.machineId && x.projectId === scope.ref.projectId);
  return p?.title ?? scope.ref.projectId;
}

/** Hub-wide (when `hubWide` names it) or one project; a project not in the list still shows by its id. */
export function ScopeSelect(props: {
  id: string;
  value: Scope | null;
  hubWide?: string;
  projects: ReadonlyArray<ProjectSummary>;
  onChange: (scope: Scope) => void;
  className?: string | undefined;
}) {
  const { projects } = props;
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
      value={value}
      placeholder="Pick a project"
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
