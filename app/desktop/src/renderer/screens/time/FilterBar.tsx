// The filter bar over all three tabs: range, project, order, machine and role, plus compare with the period before.
// On an order the range is the order's own, so range, project and compare step aside.
import { ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button, Dialog, Field, Input, Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger, Text } from "../../ui";
import { ROLE_WORD, type Names } from "./format";
import { RANGES, RANGE_LABEL, ROLES, parseWhen, period, shortWhen, type Filters, type Range } from "./filters";
import s from "./Time.module.css";

export interface FilterBarProps {
  readonly filters: Filters;
  readonly order: string | undefined;
  readonly names: Names;
  readonly nowMs: number;
  readonly onFilters: (f: Filters) => void;
  readonly onOrder: (order: string | undefined) => void;
}

const ALL = "*";

function Chip({ label, disabled, children }: { label: string; disabled?: boolean; children: ReactNode }) {
  return (
    <Menu>
      <MenuTrigger asChild disabled={disabled === true}>
        <Button variant="secondary" disabled={disabled === true} title={label} className={s.chip}>
          {label}
          <ChevronDown aria-hidden className={s.chev} />
        </Button>
      </MenuTrigger>
      <MenuContent className={s.menu}>{children}</MenuContent>
    </Menu>
  );
}

export function FilterBar({ filters: f, order, names, nowMs, onFilters, onOrder }: FilterBarProps) {
  const [custom, setCustom] = useState(false);
  const projectKey = (p: { machineId: string; projectId: string }) => `${p.machineId}/${p.projectId}`;
  const picked = f.project;
  const projectTitle = picked === undefined ? "All projects" : (names.projects.find((p) => projectKey(p) === projectKey(picked))?.title ?? picked.projectId);
  const orders = [...names.orders.entries()]
    .filter(([, o]) => f.project === undefined || o.project === projectTitle)
    .sort((a, b) => Number(b[0].replace(/\D/gu, "")) - Number(a[0].replace(/\D/gu, "")))
    .slice(0, 40);
  const orderTitle = order === undefined ? "All orders" : (names.orders.get(order)?.title ?? `Order ${order}`);
  const [since, until] = period(f, nowMs);

  return (
    <div className={s.filters} role="toolbar" aria-label="Filters">
      <Chip label={order !== undefined ? "Whole order" : RANGE_LABEL[f.range]} disabled={order !== undefined}>
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
      <Chip label={projectTitle} disabled={order !== undefined}>
        <MenuRadioGroup
          value={f.project === undefined ? ALL : projectKey(f.project)}
          onValueChange={(v) => {
            const p = names.projects.find((x) => projectKey(x) === v);
            onFilters(p === undefined ? { ...f, project: undefined } : { ...f, project: { machineId: p.machineId, projectId: p.projectId } });
          }}
        >
          <MenuRadioItem value={ALL}>All projects</MenuRadioItem>
          <MenuSeparator />
          {names.projects.map((p) => (
            <MenuRadioItem key={projectKey(p)} value={projectKey(p)}>
              {p.title}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </Chip>
      <Chip label={orderTitle}>
        <MenuRadioGroup value={order ?? ALL} onValueChange={(v) => onOrder(v === ALL ? undefined : v)}>
          <MenuRadioItem value={ALL}>All orders (totals)</MenuRadioItem>
          <MenuSeparator />
          {orders.map(([id, o]) => (
            <MenuRadioItem key={id} value={id} hint={o.project}>
              {o.title}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </Chip>
      <Chip label={f.machine ?? "All machines"}>
        <MenuRadioGroup value={f.machine ?? ALL} onValueChange={(v) => onFilters(v === ALL ? { ...f, machine: undefined } : { ...f, machine: v })}>
          <MenuRadioItem value={ALL}>All machines</MenuRadioItem>
          <MenuSeparator />
          {names.machines.map((m) => (
            <MenuRadioItem key={m} value={m}>
              {m}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </Chip>
      <Chip label={f.role === undefined ? "All roles" : ROLE_WORD[f.role]}>
        <MenuRadioGroup
          value={f.role ?? ALL}
          onValueChange={(v) => {
            const role = ROLES.find((r) => r === v);
            onFilters(role === undefined ? { ...f, role: undefined } : { ...f, role });
          }}
        >
          <MenuRadioItem value={ALL}>All roles</MenuRadioItem>
          <MenuSeparator />
          {ROLES.map((r) => (
            <MenuRadioItem key={r} value={r}>
              {ROLE_WORD[r]}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </Chip>
      <Button
        variant={f.compare && order === undefined ? "secondary" : "ghost"}
        aria-pressed={f.compare && order === undefined}
        disabled={order !== undefined}
        onClick={() => onFilters({ ...f, compare: !f.compare })}
      >
        {f.compare && order === undefined ? "Comparing with the period before" : "Compare with the period before"}
      </Button>
      <span className={s.grow} />
      {order === undefined ? (
        <Text size="xs" tone="quiet" tabular>
          {shortWhen(since)} to {until === undefined ? "now" : shortWhen(until)} UTC
        </Text>
      ) : null}
      <CustomRange open={custom} onOpenChange={setCustom} filters={f} nowMs={nowMs} onFilters={onFilters} />
    </div>
  );
}

function CustomRange({
  open,
  onOpenChange,
  filters: f,
  nowMs,
  onFilters,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filters: Filters;
  nowMs: number;
  onFilters: (f: Filters) => void;
}) {
  const [from, setFrom] = useState(() => shortWhen(f.custom?.since ?? nowMs - 7 * 86_400_000));
  const [to, setTo] = useState(() => (f.custom?.until === undefined ? "" : shortWhen(f.custom.until)));
  const [error, setError] = useState<string | undefined>();
  const apply = () => {
    const since = parseWhen(from);
    const until = to.trim() === "" ? undefined : parseWhen(to);
    if (since === undefined || (to.trim() !== "" && until === undefined)) {
      setError("Couldn't read that date. Use 2026-10-12 or 2026-10-12 09:30.");
      return;
    }
    if (until !== undefined && until <= since) {
      setError("The end is before the start.");
      return;
    }
    setError(undefined);
    onFilters({ ...f, range: "custom", custom: { since, ...(until === undefined ? {} : { until }) } });
    onOpenChange(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Custom range"
      description="Dates in UTC: 2026-10-12, or 2026-10-12 09:30."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={apply}>
            Apply
          </Button>
        </>
      }
    >
      <form
        className={s.customForm}
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <Field label="From" error={error}>
          <Input mono value={from} onChange={(e) => setFrom(e.currentTarget.value)} placeholder="2026-10-12 09:00" />
        </Field>
        <Field label="To" description="Empty means now.">
          <Input mono value={to} onChange={(e) => setTo(e.currentTarget.value)} placeholder="now" />
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
