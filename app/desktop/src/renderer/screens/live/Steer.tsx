// Steering mid-run from the app: the box under an agent's live work, with its receipts, and the sends the lead
// composer's ⌘Enter shares (its steers show in the chat, chat/ChatList.tsx). Sent with the app's paired key, as chat
// is: the hub takes it as the person's (steer_send refuses an agent key). Receipts are the order's steers in
// order_get, the read the live strip shares, which every steer.* event naming the order reads again (effects.ts).
import { ArrowUp } from "lucide-react";
import { useCallback, useState, type KeyboardEvent } from "react";
import type { AttachmentId, Steer, SteerMode, SteerTarget } from "../../../shared/contracts";
import { useDataLayer, useToolQuery } from "../../src/data/react";
import { Button, cx, IdChip, Text, Tooltip, Truncate } from "../../ui";
import { receiptsToShow, steerFailed, steerModeOn, steerReceipt, steersFor, steerTooLong } from "./steerModel";
import s from "./steer.module.css";

/** ⌘Enter, as this platform writes it. */
export const nowKeys = (): string => (window.fleetd.platform === "darwin" ? "⌘↩" : "Ctrl+↩");

/**
 * The steers this view sent, kept as the hub answered until its order lists them. `send` and `withdraw` keep their
 * identity, so the chat's memoized rows can hold them.
 */
export function useSteerSends() {
  const { call } = useDataLayer();
  const [sent, setSent] = useState<readonly Steer[]>([]);
  const keep = useCallback((steer: Steer) => setSent((all) => [steer, ...all.filter((x) => x.id !== steer.id)]), []);
  const send = useCallback(
    async (target: SteerTarget, text: string, mode: SteerMode, attachments?: readonly AttachmentId[]): Promise<string | undefined> => {
      const out = await call("steer_send", { target, text, mode, clientRequestId: crypto.randomUUID(), ...(attachments?.length ? { attachments: [...attachments] } : {}) });
      if (!out.ok) return steerFailed(out.error.code);
      keep(out.output);
      return undefined;
    },
    [call, keep],
  );
  const withdraw = useCallback(
    async (steerId: string): Promise<boolean> => {
      const out = await call("steer_withdraw", { steerId });
      if (out.ok) keep(out.output);
      return out.ok;
    },
    [call, keep],
  );
  return { sent, send, withdraw };
}

export type SteerSends = ReturnType<typeof useSteerSends>;

/** Under an agent's box: the person's steers to task `taskId` of order `workstreamId`, newest first. */
function SteerReceipts({ workstreamId, taskId, steers }: { workstreamId: string; taskId: string; steers: SteerSends }) {
  const order = useToolQuery("order_get", { workstreamId });
  const [unwithdrawn, setUnwithdrawn] = useState<string>();
  const shown = receiptsToShow(steersFor(order.data?.steers, taskId), steers.sent);
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
export function SteerBox({ workstreamId, taskId }: { workstreamId: string; taskId: string }) {
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
      <SteerReceipts workstreamId={workstreamId} taskId={taskId} steers={steers} />
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
            {`Goes straight to this agent, and its lead is told. ${nowKeys()} stops its current step.`}
          </Text>
        )}
      </div>
    </div>
  );
}
