// Steering mid-run from the app: the box under an agent's live work, and the receipts any steer shows (that box's,
// and the lead composer's ⌘Enter). Sent with the app's paired key, as chat is: the hub takes it as the person's
// (steer_send refuses an agent key). Receipts are steers_list, read again on every steer.* event (effects.ts).
import { ArrowUp } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import type { AttachmentId, Steer, SteerMode, SteerTarget } from "../../../shared/contracts";
import { useDataLayer, useToolQuery } from "../../src/data/react";
import { Button, cx, IdChip, Text, Tooltip, Truncate } from "../../ui";
import { receiptsToShow, steerFailed, steerModeOn, steerReceipt, steerTooLong } from "./steerModel";
import s from "./steer.module.css";

/** ⌘Enter, as this platform writes it. */
export const NOW_KEYS = window.fleetd.platform === "darwin" ? "⌘↩" : "Ctrl+↩";

/** The steers this view sent, kept as the hub answered until steers_list lists them. */
export function useSteerSends() {
  const { call } = useDataLayer();
  const [sent, setSent] = useState<readonly Steer[]>([]);
  const keep = (steer: Steer) => setSent((all) => [steer, ...all.filter((x) => x.id !== steer.id)]);
  const send = async (target: SteerTarget, text: string, mode: SteerMode, attachments?: readonly AttachmentId[]): Promise<string | undefined> => {
    const out = await call("steer_send", { target, text, mode, clientRequestId: crypto.randomUUID(), ...(attachments?.length ? { attachments: [...attachments] } : {}) });
    if (!out.ok) return steerFailed(out.error.code);
    keep(out.output);
    return undefined;
  };
  const withdraw = async (steerId: string): Promise<boolean> => {
    const out = await call("steer_withdraw", { steerId });
    if (out.ok) keep(out.output);
    return out.ok;
  };
  return { sent, send, withdraw };
}

/** `onlySent`: only what this view sent (the lead composer's); else the person's recent steers to `target` too. */
export function SteerReceipts({ target, steers, onlySent = false }: { target: SteerTarget; steers: ReturnType<typeof useSteerSends>; onlySent?: boolean }) {
  const enabled = !onlySent || steers.sent.length > 0;
  const listed = useToolQuery("steers_list", { ...target, limit: 20 }, { enabled });
  const [unwithdrawn, setUnwithdrawn] = useState<string>();
  const shown = receiptsToShow(listed.data?.steers, steers.sent, onlySent);
  if (shown.length === 0) return null;
  return (
    <ul className={s.receipts} aria-label="Your steers">
      {shown.map((steer) => {
        const r = steerReceipt(steer);
        return (
          <li key={steer.id} className={s.receipt} data-steer={steer.stage}>
            <span className={s.words}>
              <Truncate size="xs" tone="quiet">
                {steer.text}
              </Truncate>
            </span>
            <span className={cx(s.stage, s[`tone-${r.tone}`])}>
              <Text size="xs" tone="inherit">
                {r.line}
              </Text>
              {r.quote !== undefined ? (
                <span className={s.words}>
                  <Truncate size="xs" tone="quiet">
                    {`“${r.quote}”`}
                  </Truncate>
                </span>
              ) : null}
              {r.detail !== undefined ? <IdChip label="Details" id={r.detail} kind="error" size="xs" tone="quiet" /> : null}
              {r.withdraw ? (
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => {
                    setUnwithdrawn(undefined);
                    void steers.withdraw(steer.id).then((ok) => {
                      if (!ok) setUnwithdrawn(steer.id);
                    });
                  }}
                >
                  Withdraw
                </Button>
              ) : null}
              {unwithdrawn === steer.id && r.withdraw ? (
                <Text size="xs" tone="danger">
                  Couldn’t take it back; it may be delivered already.
                </Text>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** The box under one agent's live work: Enter at its next step, ⌘Enter stops its step. Its lead is told. */
export function SteerBox({ taskId }: { taskId: string }) {
  const target = { taskId };
  const steers = useSteerSends();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const send = (mode: SteerMode) => {
    const words = text.trim();
    if (words === "" || busy) return;
    const tooLong = steerTooLong(words);
    if (tooLong !== undefined) return setError(tooLong);
    setBusy(true);
    setError(undefined);
    // The words stay in the box until the hub has them, so a refused steer is never lost.
    void steers.send(target, words, mode).then((failed) => {
      setBusy(false);
      if (failed !== undefined) return setError(failed);
      setText((t) => (t.trim() === words ? "" : t));
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const mode = steerModeOn({ ...e, isComposing: e.nativeEvent.isComposing });
    if (mode === undefined) return;
    e.preventDefault();
    send(mode);
  };

  return (
    <div className={s.steer} data-steer-box>
      <SteerReceipts target={target} steers={steers} />
      <div className={s.box}>
        <textarea
          className={s.input}
          aria-label="Steer this agent"
          placeholder="Steer this agent"
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(undefined);
          }}
          onKeyDown={onKeyDown}
        />
        <Tooltip content="Send at its next step">
          <Button variant="primary" size="sm" iconOnly round aria-label="Send the steer" disabled={text.trim() === "" || busy} onClick={() => send("queue")}>
            <ArrowUp />
          </Button>
        </Tooltip>
      </div>
      <div role="status" className={s.note}>
        {error !== undefined ? (
          <Text size="xs" tone="danger">
            {error}
          </Text>
        ) : (
          <Text size="xs" tone="faint">
            {`Goes straight to this agent, and its lead is told. ${NOW_KEYS} stops its current step.`}
          </Text>
        )}
      </div>
    </div>
  );
}
