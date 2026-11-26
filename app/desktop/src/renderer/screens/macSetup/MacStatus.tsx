// The agents' Mac's own window, once it joined (D309): the app's only window on it, and what it opens on from then on.
// It says plainly that this Mac works as the hub's agents' Mac, whether its node is linked, what agents do on it now
// and its health with a fix each (the menu bar popover's sections, MenuBar.tsx), and offers one quiet way out: Stop
// being the agents' Mac, which removes it from its hub (or, the hub not reached, only from this Mac) and brings back
// Welcome.
import { useEffect, useState } from "react";
import type { MacMenuBarRead } from "../../../shared/macMenuBar";
import { HUB_UPDATE_WHERE, type HubBehind, type MacFound, type MacLeaveOutcome, type MacSetupFailure } from "../../../shared/macSetup";
import { settingsPath } from "../../../shared/settingsPages";
import { HubScope, useHubs } from "../../src/data/react";
import { Button, Text } from "../../ui";
import { MacSections, useMacRead, useScreenActions } from "../menuBar/MenuBar";
import { menuBarView } from "../menuBar/model";
import { statusLine } from "./model";
import s from "./macSetup.module.css";

/** The status window. `gone`: the Mac stopped being the agents' Mac outside this window (its node removed). */
export function MacStatus({ found, gone }: { found: MacFound; gone: () => void }) {
  const read = useMacRead();
  const hubs = useHubs();
  const [left, setLeft] = useState<Extract<MacLeaveOutcome, { ok: true }>>();
  useEffect(() => {
    if (read === null && left === undefined) gone();
  }, [read, left, gone]);
  if (left !== undefined) return <Left left={left} />;
  const hub = read?.hubId === null || read === undefined || read === null ? undefined : hubs.find((h) => h.id === read.hubId);
  const body = (sections: React.ReactNode) => <Status found={found} read={read ?? undefined} sections={sections} onLeft={setLeft} />;
  if (read === undefined || read === null) return body(null);
  if (hub === undefined) return body(<MacSections view={menuBarView(read, null, read.health.now)} read={read} onScreen={undefined} />);
  return (
    <HubScope key={hub.id} hub={hub}>
      <WithHub read={read} body={body} />
    </HubScope>
  );
}

function WithHub({ read, body }: { read: MacMenuBarRead; body: (sections: React.ReactNode) => React.ReactNode }) {
  const { hub, onScreen } = useScreenActions(() => {});
  return <>{body(<MacSections view={menuBarView(read, hub, read.health.now)} read={read} onScreen={onScreen} />)}</>;
}

function Status({ found, read, sections, onLeft }: { found: MacFound; read: MacMenuBarRead | undefined; sections: React.ReactNode; onLeft: (left: Extract<MacLeaveOutcome, { ok: true }>) => void }) {
  const line = read === undefined ? undefined : statusLine(read, read.health.now);
  return (
    <div className={s.status} data-screen="mac-status">
      <header className={s.statusHead}>
        <Text as="h1" size="lg" strong>
          Working as {found.hubName}’s agents’ Mac
        </Text>
        {line === undefined ? null : (
          <span className={s.statusLine} data-tone={line.tone}>
            <span className={s.dot} aria-hidden />
            <Text size="sm" tone={line.tone === "ok" ? "quiet" : "warning"}>
              {line.text}
            </Text>
          </span>
        )}
      </header>
      {read?.health.hubBehind === null || read?.health.hubBehind === undefined ? null : <HubBehindLine behind={read.health.hubBehind} hubUrl={found.hubUrl} />}
      <div className={s.sections}>{sections}</div>
      <Leave found={found} onLeft={onLeft} />
    </div>
  );
}

/** Stop being the agents' Mac: one confirm that says what happens, then the outcome. */
function Leave({ found, onLeft }: { found: MacFound; onLeft: (left: Extract<MacLeaveOutcome, { ok: true }>) => void }) {
  const [stage, setStage] = useState<"idle" | "confirm" | "leaving">("idle");
  const [failure, setFailure] = useState<MacSetupFailure>();
  const leave = () => {
    setStage("leaving");
    setFailure(undefined);
    void window.fleetd.macSetup.leave().then((out) => {
      if (out.ok) onLeft(out);
      else {
        setStage("confirm");
        setFailure(out.failure);
      }
    });
  };
  if (stage === "idle") {
    return (
      <footer className={s.leave}>
        <Button variant="ghost" size="sm" onClick={() => setStage("confirm")}>
          Stop being the agents’ Mac
        </Button>
      </footer>
    );
  }
  return (
    <footer className={s.confirm} role="alertdialog" aria-label="Stop being the agents’ Mac">
      <Text size="sm" strong>
        Stop being {found.hubName}’s agents’ Mac?
      </Text>
      <Text size="sm" tone="quiet">
        {found.machineId} leaves {found.hubName}, its node stops and its key is deleted. Agents can’t use this Mac after.
      </Text>
      {failure === undefined ? null : (
        <div role="alert">
          <Text size="sm" tone="danger">
            {failure.message} {failure.fix ?? ""}
          </Text>
        </div>
      )}
      <div className={s.actions}>
        <Button variant="danger" size="md" disabled={stage === "leaving"} onClick={leave}>
          {stage === "leaving" ? "Leaving…" : "Stop being the agents’ Mac"}
        </Button>
        <Button variant="ghost" size="md" disabled={stage === "leaving"} onClick={() => setStage("idle")}>
          Cancel
        </Button>
      </div>
    </footer>
  );
}

function Left({ left }: { left: Extract<MacLeaveOutcome, { ok: true }> }) {
  const line =
    left.told === "removed" || left.told === "none"
      ? `${left.machineId} left ${left.hubName}.`
      : `${left.hubName} wasn’t reached, so it shows ${left.machineId} offline until an admin removes it there.`;
  return (
    <div className={s.status} data-screen="mac-left" data-told={left.told}>
      <header className={s.statusHead}>
        <Text as="h1" size="lg" strong>
          This Mac isn’t the agents’ Mac any more
        </Text>
        <Text size="sm" tone="quiet">
          {line}
        </Text>
      </header>
      <div className={s.actions}>
        <Button variant="primary" size="md" autoFocus onClick={() => void window.fleetd.macSetup.exit()}>
          Continue
        </Button>
      </div>
    </div>
  );
}

/** The hub runs an older fleetd than this Mac: both work, and the hub's Update brings it level. */
export function HubBehindLine({ behind, hubUrl }: { behind: HubBehind; hubUrl: string }) {
  const [asked, setAsked] = useState<"no" | "asking" | "started">("no");
  const [failure, setFailure] = useState<MacSetupFailure>();
  const update = () => {
    setAsked("asking");
    setFailure(undefined);
    void window.fleetd.macSetup.updateHub(hubUrl).then((outcome) => {
      setAsked(outcome.ok ? "started" : "no");
      if (!outcome.ok) setFailure(outcome.failure);
    });
  };
  const line =
    asked === "started"
      ? "Your workspace is updating. It restarts in a moment, then runs the same build as this Mac."
      : behind.who === "admin"
        ? "Your workspace runs an older fleetd than this Mac. Agents can use the Mac already; Update brings the workspace level."
        : behind.who === "member"
          ? `Your workspace runs an older fleetd than this Mac. Agents can use the Mac already; ask an admin of the workspace to press Update in ${settingsPath(false, "Machines", "Updates")}.`
          : `Your workspace runs an older fleetd than this Mac. Agents can use the Mac already. ${HUB_UPDATE_WHERE}`;
  return (
    <div className={s.notice} role="status" data-hub-behind={behind.who}>
      <Text size="sm">{line}</Text>
      {failure === undefined ? null : (
        <Text size="sm" tone="danger">
          {failure.fix === undefined ? failure.message : `${failure.message} ${failure.fix}`}
        </Text>
      )}
      {behind.who === "admin" && asked !== "started" ? (
        <div className={s.actions}>
          <Button variant="secondary" size="md" disabled={asked === "asking"} onClick={update}>
            {asked === "asking" ? "Starting the update…" : "Update the workspace"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

