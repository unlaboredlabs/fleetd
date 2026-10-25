// The one filter row above everything it scopes: the range first, then the project, then compare (dataviz:
// filters in one row, date range first).
import { ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button, Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger, Text } from "../../ui";
import type { ProjectKey } from "../shell/routes";
import { stampMs } from "../time/format";
import { CustomRange } from "../time/FilterBar";
import { RANGES, RANGE_LABEL, period, type Filters, type Range } from "./filters";
import s from "./Factory.module.css";

const ALL = "*";

export interface FilterRowProps {
  readonly filters: Filters;
  readonly project: ProjectKey | null;
  readonly projects: readonly (ProjectKey & { readonly title: string })[];
  readonly nowMs: number;
  readonly onFilters: (f: Filters) => void;
  readonly onProject: (p: ProjectKey | null) => void;
}

const keyOf = (p: ProjectKey) => `${p.machineId}/${p.projectId}`;

function Chip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="secondary" title={label} className={s.chip}>
          {label}
          <ChevronDown aria-hidden className={s.chev} />
        </Button>
      </MenuTrigger>
      <MenuContent className={s.menu}>{children}</MenuContent>
    </Menu>
  );
}

export function FilterRow({ filters: f, project, projects, nowMs, onFilters, onProject }: FilterRowProps) {
  const [custom, setCustom] = useState(false);
  const title = project === null ? "All projects" : (projects.find((p) => keyOf(p) === keyOf(project))?.title ?? project.projectId);
  const [since, until] = period(f, nowMs);
  return (
    <div className={s.filters} role="toolbar" aria-label="Filters">
      <Chip label={RANGE_LABEL[f.range]}>
        <MenuRadioGroup
          value={f.range}
          onValueChange={(v) => {
            if (v === "custom") setCustom(true);
            else onFilters({ ...f, range: v as Range });
          }}
        >
          {RANGES.map((r) => (
            <MenuRadioItem key={r} value={r}>
              {r === "custom" ? "Custom…" : RANGE_LABEL[r]}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </Chip>
      <Chip label={title}>
        <MenuRadioGroup value={project === null ? ALL : keyOf(project)} onValueChange={(v) => onProject(projects.find((p) => keyOf(p) === v) ?? null)}>
          <MenuRadioItem value={ALL}>All projects</MenuRadioItem>
          <MenuSeparator />
          {projects.map((p) => (
            <MenuRadioItem key={keyOf(p)} value={keyOf(p)} hint={p.machineId}>
              {p.title}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </Chip>
      <Button variant={f.compare ? "secondary" : "ghost"} aria-pressed={f.compare} onClick={() => onFilters({ ...f, compare: !f.compare })}>
        {f.compare ? "Comparing with the period before" : "Compare with the period before"}
      </Button>
      <span className={s.grow} />
      <Text size="xs" tone="quiet" tabular>
        {stampMs(since)} to {until === undefined ? "now" : stampMs(until)}
      </Text>
      <CustomRange open={custom} onOpenChange={setCustom} custom={f.custom} nowMs={nowMs} onApply={(c) => onFilters({ ...f, range: "custom", custom: c })} />
    </div>
  );
}
