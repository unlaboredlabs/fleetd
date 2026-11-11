// The one status of updates (model.ts), as rows of a Settings group: its title with one quiet line and its one
// button, then a row per machine to look at, only when there is one. Hub › Machines › Updates and General's Version both show it.
import { useState } from "react";
import { Button, copyText, Dot, InlineCode, Text } from "../../ui";
import { SettingsList, SettingsListRow, SettingsRow } from "../settings/parts";
import { useUpdateAct } from "./hooks";
import type { Status } from "./model";
import s from "./updates.module.css";

/** Inline `code` in a plain line, as the hub's own words may carry. */
export function Line({ text }: { text: string }) {
  const parts = text.split("`");
  return <>{parts.map((part, i) => (i % 2 === 1 && i < parts.length - 1 ? <InlineCode key={i}>{part}</InlineCode> : part))}</>;
}

function Command({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <Text size="sm" tone="quiet">
        Then install it from the folder it downloaded to:
      </Text>
      <div className={s.command}>
        <Text mono size="sm">
          {command}
        </Text>
        <Button variant="ghost" onClick={() => void copyText(command).then(setCopied)} onBlur={() => setCopied(false)}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </>
  );
}

export function UpdateStatus({ status }: { status: Status }) {
  const act = useUpdateAct();
  const action = status.action;
  return (
    <>
      <SettingsRow
        label={status.title}
        title={
          <span className={s.title} role={status.kind === "failed" ? "alert" : "status"}>
            {status.title}
            {status.kind === "failed" ? <Dot color="var(--danger)" /> : null}
          </span>
        }
        line={status.detail === undefined ? undefined : <Line text={status.detail} />}
        control={
          action === undefined ? undefined : (
            <Button variant={status.kind === "available" && status.quiet !== true ? "primary" : "secondary"} onClick={() => act(action.act)}>
              {action.label}
            </Button>
          )
        }
        data={{ "data-update-status": status.kind }}
      >
        {status.command === undefined ? null : <Command command={status.command} />}
      </SettingsRow>
      {status.rows.length === 0 ? null : (
        <SettingsList label="Machines to look at">
          {status.rows.map((row) => (
            <SettingsListRow
              key={row.key}
              label={row.name}
              name={
                <span className={s.title}>
                  {row.name}
                  {row.tone === "danger" ? <Dot color="var(--danger)" label="Didn't update" /> : null}
                </span>
              }
              data={{ "data-update-machine": row.tone }}
            >
              <Text size="sm" tone="quiet">
                <Line text={row.why} />
              </Text>
            </SettingsListRow>
          ))}
        </SettingsList>
      )}
    </>
  );
}
