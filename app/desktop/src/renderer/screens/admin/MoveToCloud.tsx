// Move to the cloud (decision hosted.move-hub-to-cloud): a self-hosted hub, whole, into an empty fleetd cloud team.
// One row on Settings › Hub › Setup opens a short sheet: sign in to fleetd cloud (the app's own sign-in, asking which
// of the person's teams are empty, a new one made when none is), the team it goes into, then Move. Main hands the
// hub the team's address and this device's key there (the page never sees it); the hub uploads, the cloud loads it,
// and the sheet follows hub_move_status: packing, uploading with its share, loading, then each machine rejoining the
// team by itself. Done, the app opens the team. A move that stops says why and the one way forward; nothing changed.
// A moved hub shows a banner (MovedBanner) over every screen, with Undo.
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { HubMove, HubMoveMachine } from "../../../shared/contracts";
import type { MoveTarget } from "../../../shared/cloud";
import { useDataLayer, useHub, useHubs } from "../../src/data/react";
import { Button, Dialog, Text } from "../../ui";
import { refreshCloud, useCloud } from "../onboarding/cloud";
import { SettingsList, SettingsListRow, SettingsSection } from "../settings/parts";
import { errorText, useHubCall } from "../settings/hub";
import { switchHub } from "../shell/hubSwipe";
import { useAdministers } from "./role";
import m from "./move.module.css";
import b from "../onboarding/onboarding.module.css";

const noInput = {};
const BUSY: ReadonlyArray<HubMove["phase"]> = ["packing", "uploading", "loading"];

/** The hub's move, read every second while `fast`, else as other reads are; undefined on a hub that doesn't serve it. */
function useMove(fast: boolean, enabled = true): { move: HubMove | undefined; refetch: () => void } {
  const layer = useDataLayer();
  const q = useQuery({ ...layer.toolQuery("hub_move_status", noInput), enabled, refetchInterval: fast ? 1000 : 30_000, retry: false });
  return { move: q.data?.move, refetch: () => void q.refetch() };
}

/** The row on Setup: only on a self-hosted hub this build can move to fleetd cloud. */
export function MoveRow() {
  const hub = useHub();
  const { state } = useCloud();
  const [open, setOpen] = useState(false);
  const { move } = useMove(false, state.available && hub.cloud !== true);
  if (!state.available || hub.cloud === true || move === undefined) return null;
  return (
    <SettingsSection>
      <SettingsList label="Move">
        <SettingsListRow name="Move to the cloud" label="Move to the cloud" open={{ onClick: () => setOpen(true) }} data={{ "data-move": move.phase }} />
      </SettingsList>
      {open ? <MoveSheet onClose={() => setOpen(false)} /> : null}
    </SettingsSection>
  );
}

type Local = { at: "start" } | { at: "signing" } | { at: "pick"; targets: MoveTarget[]; chosen: string } | { at: "handing" } | { at: "refused"; message: string };

const pct = (move: HubMove) => (move.totalBytes ? Math.min(100, Math.round(((move.bytes ?? 0) / move.totalBytes) * 100)) : 0);

/** A machine's state in words, as the sheet and the banner say it. */
export const machineWords = (x: HubMoveMachine): string =>
  x.state === "joined"
    ? "Rejoined"
    : x.state === "rejoining"
      ? "Rejoining…"
      : x.state === "offline"
        ? "Rejoins when it's back online"
        : x.state === "updating"
          ? "Updating fleetd first"
          : x.why !== undefined
            ? "Waiting"
            : "Comes along";

const pending = (move: HubMove) => move.machines.some((x) => x.state === "waiting" || x.state === "rejoining" || x.state === "updating");

/** The team's hub in this app: the one picked here, else the account's hub of the team's name. */
function useTeamHub(name: string | undefined, picked?: MoveTarget): { id: string; label: string } | undefined {
  const hubs = useHubs();
  const at = hubs.find((h) => h.cloud === true && (picked !== undefined ? h.id === picked.hub : h.label === name));
  return at === undefined ? undefined : { id: at.id, label: at.label };
}

function Machines({ move }: { move: HubMove }) {
  if (move.machines.length === 0) return null;
  return (
    <ul className={m.machines} aria-label="Machines">
      {move.machines.map((x) => (
        <li key={x.machineId} data-machine={x.machineId} data-state={x.state}>
          <Text>{x.name}</Text>
          <Text size="sm" tone={x.state === "joined" ? "success" : x.why !== undefined && x.state !== "offline" ? "warning" : "quiet"} {...(x.why === undefined ? {} : { title: x.why })}>
            {machineWords(x)}
          </Text>
        </li>
      ))}
    </ul>
  );
}

export function MoveSheet({ onClose }: { onClose: () => void }) {
  const hub = useHub();
  const call = useHubCall();
  const [local, setLocal] = useState<Local>({ at: "start" });
  const [chosen, setChosen] = useState<MoveTarget>();
  const [startedHere, setStartedHere] = useState(false);
  const { move, refetch } = useMove(true);
  const team = useTeamHub(move?.team, chosen);
  const busy = move !== undefined && BUSY.includes(move.phase);
  const shown = move !== undefined && (busy || move.phase === "done" || (move.phase === "failed" && startedHere));

  // Done with every machine handed over (or offline, to come later), and nothing left out to read first: the app opens
  // the team. With something left out (fleetd's GitHub App to install there, say), the sheet stays to say it.
  const settled = move?.phase === "done" && !pending(move) && (move.skipped ?? []).length === 0;
  useEffect(() => {
    if (settled && startedHere && team !== undefined) {
      onClose();
      switchHub(team.id);
    }
  }, [settled, startedHere, team, onClose]);

  const signIn = async () => {
    setLocal({ at: "signing" });
    const signed = await window.fleetd.cloud.signIn({ move: true });
    if (!signed.ok) {
      setLocal(signed.cancelled === true ? { at: "start" } : { at: "refused", message: `${signed.failure.message}${signed.failure.fix ? ` ${signed.failure.fix}` : ""}` });
      return;
    }
    // Invitations are another team's: the move goes into the person's own.
    const finished = await window.fleetd.cloud.finish([]);
    if (!finished.ok) return setLocal({ at: "refused", message: `${finished.failure.message}${finished.failure.fix ? ` ${finished.failure.fix}` : ""}` });
    // Signed in now: Settings › Hubs & devices and the rest read it, as after the first screen's sign-in.
    void refreshCloud();
    const targets = await window.fleetd.cloud.moveTargets();
    const first = targets[0];
    if (first === undefined) return setLocal({ at: "refused", message: "Every team of yours on fleetd cloud already has bots, and a hub moves only into an empty team. Sign in with another account." });
    setChosen(first);
    setLocal({ at: "pick", targets, chosen: first.hub });
  };

  const go = async (target: MoveTarget) => {
    setLocal({ at: "handing" });
    setStartedHere(true);
    const out = await window.fleetd.cloud.move(hub.id, target.hub);
    if (!out.ok) {
      setStartedHere(false);
      setLocal({ at: "refused", message: out.message });
      return;
    }
    refetch();
  };

  const stop = () => void call("hub_move_cancel", noInput).then(refetch, (e: unknown) => setLocal({ at: "refused", message: errorText(e) }));

  let body: React.ReactNode;
  let footer: React.ReactNode;
  if (shown) {
    const line =
      move.phase === "packing"
        ? "Packing this hub…"
        : move.phase === "uploading"
          ? `Uploading to ${move.team ?? "fleetd cloud"}… ${String(pct(move))}%`
          : move.phase === "loading"
            ? `${move.team ?? "fleetd cloud"} is loading this hub…`
            : move.phase === "done"
              ? `Moved to ${move.team ?? "fleetd cloud"}.`
              : (move.failure?.message ?? "The move stopped.");
    body = (
      <div className={m.body} data-move-phase={move.phase}>
        <p role={move.phase === "failed" ? "alert" : "status"} className={m.line}>
          <Text tone={move.phase === "failed" ? "danger" : "default"}>{line}</Text>
        </p>
        {busy ? (
          <div className={m.bar} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={move.phase === "uploading" ? pct(move) : undefined}>
            <span data-indeterminate={move.phase !== "uploading" || undefined} style={move.phase === "uploading" ? { width: `${String(pct(move))}%` } : undefined} />
          </div>
        ) : null}
        {move.phase === "failed" && move.failure !== undefined ? <Text tone="quiet">{move.failure.fix}</Text> : null}
        {move.phase !== "failed" ? <Machines move={move} /> : null}
        {move.phase === "done" && move.skipped !== undefined && move.skipped.length > 0 ? (
          <div className={m.left} data-move-skipped="">
            <Text size="sm" tone="quiet">
              Not moved
            </Text>
            <ul aria-label="Not moved">
              {move.skipped.map((line) => (
                <li key={line}>
                  <Text size="sm">{line}</Text>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    );
    const again = move.failure?.reason === "signed_out" || move.failure?.reason === "not_empty" ? "Sign in again" : "Try again";
    footer =
      move.phase === "failed" ? (
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setStartedHere(false);
              if (again === "Try again" && chosen !== undefined) void go(chosen);
              else void signIn();
            }}
          >
            {again}
          </Button>
        </>
      ) : move.phase === "done" ? (
        <Button variant="primary" disabled={team === undefined} onClick={() => team !== undefined && (onClose(), switchHub(team.id))}>
          {`Open ${team?.label ?? move.team ?? "the team"}`}
        </Button>
      ) : move.phase === "loading" ? null : (
        // While the cloud loads it, all or nothing, there is nothing to stop: no button at all.
        <Button variant="ghost" onClick={stop}>
          Stop
        </Button>
      );
  } else if (local.at === "pick") {
    body = (
      <div className={m.body}>
        {local.targets.length === 1 ? (
          <Text>{`Into ${local.targets[0]?.name ?? "your team"}`}</Text>
        ) : (
          <div className={m.targets} role="radiogroup" aria-label="Team">
            {local.targets.map((t) => (
              <label key={t.hub}>
                <input
                  type="radio"
                  name="team"
                  checked={local.chosen === t.hub}
                  onChange={() => {
                    setChosen(t);
                    setLocal({ ...local, chosen: t.hub });
                  }}
                />
                <Text>{t.name}</Text>
              </label>
            ))}
          </div>
        )}
        {move !== undefined ? <Machines move={move} /> : null}
      </div>
    );
    footer = (
      <>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => chosen !== undefined && void go(chosen)}>
          Move
        </Button>
      </>
    );
  } else {
    body =
      local.at === "refused" ? (
        <p role="alert" className={m.line}>
          <Text tone="danger">{local.message}</Text>
        </p>
      ) : local.at === "signing" ? (
        <Text tone="quiet">Finish signing in in your browser…</Text>
      ) : local.at === "handing" ? (
        <Text tone="quiet">Starting…</Text>
      ) : null;
    footer =
      local.at === "signing" ? (
        <Button variant="ghost" onClick={() => void window.fleetd.cloud.cancel()}>
          Cancel
        </Button>
      ) : (
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={local.at === "handing"} onClick={() => void signIn()}>
            {local.at === "refused" ? "Sign in again" : "Sign in to fleetd cloud"}
          </Button>
        </>
      );
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Move to the cloud"
      description={shown ? undefined : "This hub's bots, chats, memory, orders and vault go into a fleetd cloud team, and its machines rejoin there. Here it pauses."}
      footer={footer}
    >
      <div data-screen="settings.hub.move">{body}</div>
    </Dialog>
  );
}

/** Over every screen of a hub that moved (or is moving): its bots are paused here; Undo runs them here again. */
export function MovedBanner() {
  const hub = useHub();
  const administers = useAdministers();
  const call = useHubCall();
  const { move, refetch } = useMove(false, hub.cloud !== true);
  const team = useTeamHub(move?.paused?.team);
  const [error, setError] = useState<string>();
  if (move?.paused === undefined) return null;
  const done = move.phase === "done" || move.phase === "failed";
  // Failed while the pause stays: this hub lost track of the move, so whether the team has its bots is for the person to see.
  const text =
    move.phase === "done"
      ? `This hub moved to fleetd cloud (${move.paused.team}). Its bots are paused here.`
      : move.phase === "failed"
        ? `This hub's move to fleetd cloud (${move.paused.team}) may not have finished. Its bots are paused here until you check the team.`
        : `Moving this hub to fleetd cloud (${move.paused.team})… Its bots are paused until it's done.`;
  return (
    <div className={b.banner} data-tone="warning" role="status" data-banner="moved">
      <div className={b.bannerLine}>
        <Text>{error ?? text}</Text>
        <span className={b.bannerAction}>
          {team !== undefined && done ? (
            <Button variant="secondary" onClick={() => switchHub(team.id)}>
              {`Open ${team.label}`}
            </Button>
          ) : null}
          {administers && done ? (
            <Button variant="ghost" onClick={() => void call("hub_move_resume", noInput).then(refetch, (e: unknown) => setError(errorText(e)))}>
              Undo
            </Button>
          ) : null}
        </span>
      </div>
    </div>
  );
}
