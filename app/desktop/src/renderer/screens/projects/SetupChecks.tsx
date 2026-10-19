// Setup checks on Machines: the hub's doctor results (doctor_list, through the data layer, refetched on
// doctor.changed), with Re-run, and each failing check's fix: a command to copy, or a Fix button the hub runs.
// The palette and doctor notifications send people here for exactly this.

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import type { DoctorCheck } from "../../../shared/contracts";
import { CallError, callKey } from "../../src/data/queries";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { Button, Dot, InlineCode, Text, copyText, cx, humanizeKey, toast } from "../../ui";
import { HubText } from "./HubText";
import { agoText } from "./machineText";
import s from "./projects.module.css";

const allChecks = {};

/** The hub's check names, said plainly; anything newer falls back to its words. */
const LABELS: Readonly<Record<string, string>> = {
  reachable: "Hub reachable",
  gh_auth: "GitHub CLI login",
  claude_login: "Claude login",
  claude_version: "Claude version",
  claude_auto_memory: "Claude auto memory",
  https: "HTTPS",
  online: "Node online",
  runner_conformance: "Runner",
  commit_identity: "Commit identity",
  disk: "Free disk space",
};

/** "devbox/claude_login" → "Claude login". The id itself never shows. */
export const checkLabel = (id: string): string => {
  const name = id.slice(id.indexOf("/") + 1);
  return LABELS[name] ?? humanizeKey(name);
};

const DOT: Readonly<Record<DoctorCheck["status"], string>> = {
  ok: "var(--success)",
  warn: "var(--warning)",
  fail: "var(--danger)",
  unknown: "var(--faint)",
};

/** Hub checks first, then each machine's, keeping the hub's order inside a group. */
export const groupChecks = (
  checks: ReadonlyArray<DoctorCheck>,
  name: (machineId: string) => string,
): ReadonlyArray<{ readonly title: string; readonly checks: ReadonlyArray<DoctorCheck> }> => {
  const groups = new Map<string, Array<DoctorCheck>>();
  for (const c of checks) {
    const title = c.scope === "hub" || c.machineId === undefined ? "Hub" : name(c.machineId);
    const list = groups.get(title);
    if (list) list.push(c);
    else groups.set(title, [c]);
  }
  return [...groups].map(([title, list]) => ({ title, checks: list }));
};

export function SetupChecks({ now }: { now: number }) {
  const data = useDataLayer();
  const query = useToolQuery("doctor_list", allChecks);
  const machines = useData((d) => d.machines);
  const [rerunning, setRerunning] = useState(false);

  const rerun = async () => {
    setRerunning(true);
    const out = await data.call("doctor_list", { rerun: true }, { timeoutMs: 120_000 });
    setRerunning(false);
    if (out.ok) data.queryClient.setQueryData(callKey("doctor_list", allChecks), out.output);
    else toast({ title: "The checks didn't re-run", description: out.error.message, tone: "danger" });
  };

  const checked = query.data ? `Checked ${agoText(now - Date.parse(query.data.checkedAt))}` : query.error ? "" : "Checking…";
  const error = query.error instanceof CallError ? query.error.error : query.error ? { message: query.error.message } : undefined;

  return (
    <section className={s.checks} aria-label="Setup checks" data-screen="machines.checks">
      <div className={s.pageHead}>
        <Text as="h2" size="lg" strong className={cx(s.pageTitle)}>
          Setup checks
        </Text>
        {checked ? (
          <Text size="sm" tone="quiet">
            {checked}
          </Text>
        ) : null}
        <Button variant="ghost" disabled={rerunning} onClick={() => void rerun()}>
          {rerunning ? "Re-running…" : "Re-run"}
        </Button>
      </div>
      {error ? (
        <Text tone="danger">
          <HubText>{"fix" in error && error.fix ? `${error.message} ${error.fix}` : error.message}</HubText>
        </Text>
      ) : null}
      {query.data
        ? groupChecks(query.data.checks, (id) => machines[id]?.name ?? id).map((g) => (
            <div key={g.title} className={s.checkGroup}>
              <Text as="h3" size="sm" tone="quiet" strong>
                {g.title}
              </Text>
              {g.checks.map((c) => (
                <CheckRow key={c.id} check={c} />
              ))}
            </div>
          ))
        : null}
    </section>
  );
}

function CheckRow({ check }: { check: DoctorCheck }) {
  const data = useDataLayer();
  const [fixing, setFixing] = useState(false);
  const ok = check.status === "ok";
  const fix = ok ? undefined : check.fix;

  const runFix = async () => {
    setFixing(true);
    const out = await data.call("doctor_fix", { checkId: check.id }, { timeoutMs: 120_000 });
    setFixing(false);
    if (!out.ok) {
      toast({ title: `${checkLabel(check.id)}: the fix didn't run`, description: out.error.fix ?? out.error.message, tone: "danger" });
      return;
    }
    toast({ title: checkLabel(check.id), description: out.output.ran, tone: out.output.check.status === "ok" ? "success" : "warning" });
    void data.queryClient.invalidateQueries({ queryKey: callKey("doctor_list", allChecks) });
  };

  return (
    <div className={s.checkRow}>
      <Dot color={DOT[check.status]} label={check.status} />
      <Text strong={!ok}>{checkLabel(check.id)}</Text>
      <div className={s.checkBody}>
        <Text tone={ok ? "quiet" : "default"}>
          <HubText>{check.message}</HubText>
        </Text>
        {fix ? (
          <>
            {fix.label ? (
              <Text size="sm" tone="quiet">
                <HubText>{fix.label}</HubText>
              </Text>
            ) : null}
            {fix.kind === "manual" && fix.command ? <CommandLine command={fix.command} /> : null}
            {fix.kind === "auto" ? (
              <div>
                <Button disabled={fixing} onClick={() => void runFix()}>
                  {fixing ? "Fixing…" : "Fix"}
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={s.command}>
      <InlineCode>{command}</InlineCode>
      <Button
        variant="quiet"
        iconOnly
        aria-label="Copy the command"
        onClick={() => {
          void copyText(command).then((done) => {
            setCopied(done);
            if (done) window.setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}
