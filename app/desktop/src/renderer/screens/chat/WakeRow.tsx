// The bot in the reply's place while its computer starts (shared/wake.ts, the person's pick of W792's designs): it
// arrives asleep, stirs, and wakes with its computer's steps, one quiet word beside it that rises out as the next rises
// in; once its lead thinks, its own look says so with no word, and its working look stands in for the typing dots until
// the reply lands where it sat. A failed try slumps, with one plain reason and a Try again that counts down to the
// start's own retry and goes at once when pressed; a press that starts nothing says why beside it.
import { useEffect, useState, type ReactNode } from "react";
import { STIR_MS, tryAgainLabel, tryAgainNow, wakePose, wakeShown, wakeWords, type Wake } from "../../../shared/wake";
import { useData, useDataLayer } from "../../src/data/react";
import { projectKey } from "../../src/data/store";
import { Avatar } from "../../ui";
import { usePicture } from "../projects/ProjectAvatar";
import type { ProjectRef } from "./slots";
import { useHubNow, useWake } from "./wake";
import s from "./wake.module.css";

/** The size of the bot in the reply's place: its face reads at a glance, a step under a bubble's line pair. */
const BOT_SIZE = 36;

export function WakeRow({ project, writing }: { project: ProjectRef; writing: boolean }) {
  const key = projectKey(project);
  const wake = useWake(key, writing);
  if (!wakeShown(wake) || wake === undefined) return null;
  return <Woken project={project} wake={wake} />;
}

function Woken({ project, wake }: { project: ProjectRef; wake: Wake }) {
  const key = projectKey(project);
  const summary = useData((d) => d.projects[key]);
  const picture = usePicture(summary);
  const [stirred, setStirred] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setStirred(true), STIR_MS);
    return () => clearTimeout(timer);
  }, []);
  const now = useHubNow(wake.phase === "waking" || wake.phase === "failed");
  const said = wakeWords(wake, now);
  const words =
    said === undefined ? undefined : (
      <>
        {said.words}
        {said.count === undefined ? null : <span className={s.count}>{said.count}</span>}
      </>
    );
  return (
    <div className={s.row} data-wake={wake.phase} role="status" aria-label={said?.words ?? (wake.phase === "thinking" ? "Thinking" : "Working")}>
      <span className={s.bot}>
        <Avatar name={summary?.title ?? ""} size={BOT_SIZE} src={picture} bot={wakePose(wake, stirred)} color={summary?.avatarColor} shape={summary?.avatarShape} />
      </span>
      <span className={s.words}>
        {words === undefined ? null : <Swap id={said?.count === undefined ? (said?.words ?? "") : "slow"}>{words}</Swap>}
        {wake.phase === "failed" ? <TryAgain key={`${wake.reason}|${String(wake.retryAt)}`} project={project} wake={wake} now={now} /> : null}
      </span>
    </div>
  );
}

/** Try again: the start's waiting try goes now. A press that started nothing says why beside it (shared/wake.ts tryAgainNote). */
function TryAgain({ project, wake, now }: { project: ProjectRef; wake: Extract<Wake, { phase: "failed" }>; now: number }) {
  const layer = useDataLayer();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  return (
    <>
      <button
        type="button"
        className={s.act}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setNote(undefined);
          void tryAgainNow(() => layer.call("chat_start_now", { projectRef: project })).then((said) => {
            setNote(said);
            setBusy(false);
          });
        }}
      >
        {tryAgainLabel(wake, now)}
      </button>
      {note === undefined ? null : (
        <span className={s.note} role="status">
          {note}
        </span>
      )}
    </>
  );
}

/** Words that give way to the next: the old rise out as the new rise in, on the spring. `id` names what they say. */
function Swap({ id, children }: { id: string; children: ReactNode }) {
  const [shown, setShown] = useState<{ id: string; node: ReactNode; old?: { id: string; node: ReactNode } | undefined }>({ id, node: children });
  if (shown.id !== id) setShown({ id, node: children, old: { id: shown.id, node: shown.node } });
  else if (shown.node !== children) setShown({ ...shown, node: children });
  const leaving = shown.old?.id;
  useEffect(() => {
    if (leaving === undefined) return;
    const timer = setTimeout(() => setShown((x) => ({ id: x.id, node: x.node })), 420);
    return () => clearTimeout(timer);
  }, [leaving]);
  return (
    <span className={s.swap}>
      {shown.old === undefined ? null : (
        <span key={`old:${shown.old.id}`} className={s.out} aria-hidden>
          {shown.old.node}
        </span>
      )}
      <span key={shown.id} className={shown.old === undefined ? undefined : s.in}>
        {shown.node}
      </span>
    </span>
  );
}
