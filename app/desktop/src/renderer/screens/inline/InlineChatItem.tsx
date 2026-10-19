// The only two things in a lead chat that aren't messages, because a message can't carry them safely: a secret the
// person types (it never enters the transcript) and a risky command the person approves or denies. F3's chat list
// renders this for a message with an `item`. The item comes from E1's layer, which re-reads it when the hub
// re-emits its chat.message; the only state here is what the person just did, until that update says the same.
import { useMemo, useRef, useState } from "react";
import type { ChatItem, CommandApprovalItem, Machine, SecretRequestItem } from "../../../shared/contracts";
import type { HubError } from "../../../shared/hub";
import { Button, Code, cx, InlineCode, Input, Text } from "../../ui";
import { useData, useDataLayer } from "../../src/data/react";
import { prose } from "./prose";
import { approvalOutcome, classWords, secretEnvLine, secretOutcome, secretTarget, shellLine, type Outcome } from "./request";
import s from "./InlineChatItem.module.css";

const errorText = (e: HubError): string => (e.fix === undefined ? e.message : `${e.message} ${e.fix}`);

/** Machines with the live feed's status, which is newer than the snapshot's. */
const useMachines = (): Readonly<Record<string, Machine>> => {
  const machines = useData((d) => d.machines);
  const live = useData((d) => d.live.machines);
  return useMemo(
    () =>
      Object.fromEntries(
        Object.entries(machines).map(([id, m]) => {
          const status = live[id]?.status;
          return [id, status === undefined ? m : { ...m, status }];
        }),
      ),
    [machines, live],
  );
};

const useLive = (): boolean => useData((d) => d.fresh && d.hub.phase === "live");

/**
 * What the person did, shown while the item the layer holds is still `open`: the hub's own update (any other state)
 * wins as soon as it arrives.
 */
const useSent = <T extends { readonly state: string }>(item: T) => {
  const [sent, setSent] = useState<Partial<T> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown: T = sent !== null && item.state === "open" ? { ...item, ...sent } : item;
  const run = (work: () => Promise<{ ok: true; sent: Partial<T> } | { ok: false; error: HubError }>): void => {
    setBusy(true);
    setError(null);
    void work().then((out) => {
      setBusy(false);
      if (out.ok) setSent(out.sent);
      else setError(errorText(out.error));
    });
  };
  return { shown, busy, error, run };
};

export function InlineChatItem({ item }: { item: ChatItem }) {
  return item.kind === "secret_request" ? <SecretItem item={item} /> : <ApprovalItem item={item} />;
}

function OutcomeLine({ outcome }: { outcome: Outcome }) {
  return (
    <p className={s.outcome} aria-live="polite">
      <Text size="sm" tone={outcome.tone}>
        {prose(outcome.text)}
      </Text>
    </p>
  );
}

function ErrorLine({ text }: { text: string | null }) {
  return text === null ? null : (
    <p role="alert" className={s.outcome}>
      <Text size="sm" tone="danger">
        {text}
      </Text>
    </p>
  );
}

function SecretItem({ item }: { item: SecretRequestItem }) {
  const machines = useMachines();
  const live = useLive();
  const { shown, busy, error, run } = useSent(item);
  const field = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState(false);
  const outcome = secretOutcome(shown);
  const target = secretTarget(machines, item);

  // The value goes from the field straight to main, which seals it; the field is emptied in the same step, and
  // nothing here keeps a copy.
  const save = (): void => {
    const el = field.current;
    if (el === null || !target.ok || !live || busy) return;
    const value = el.value;
    el.value = "";
    setTyped(false);
    if (value === "") return;
    run(async () => {
      const out = await window.fleetd.secret.submit({ requestId: item.requestId, boxPubKey: target.boxPubKey, value });
      return out.ok ? { ok: true, sent: { state: "stored", fingerprint: out.fingerprint } } : out;
    });
  };

  return (
    <section className={s.item} data-request={item.requestId} aria-label="Secret for the lead">
      <div className={s.head}>
        <Text size="xs" tone="quiet" strong>
          Secret
        </Text>
        <InlineCode>{item.name}</InlineCode>
      </div>
      <Text as="p" strong className={cx(s.title)}>
        {prose(item.text)}
      </Text>
      {outcome !== undefined ? (
        <OutcomeLine outcome={outcome} />
      ) : !target.ok ? (
        <p role="alert" className={s.outcome}>
          <Text size="sm" tone="warning">{`${target.message} ${target.fix}`}</Text>
        </p>
      ) : (
        <>
          <Text as="p" size="sm" className={cx(s.line)}>
            {`It is saved ${target.where}.`}
          </Text>
          <div className={s.row}>
            <Input
              ref={field}
              type="password"
              aria-label="Secret value"
              placeholder="Paste or type the value"
              autoComplete="off"
              className={cx(s.field)}
              disabled={!live || busy}
              onChange={(e) => setTyped(e.target.value !== "")}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  e.stopPropagation();
                  save();
                }
              }}
            />
            <Button variant="primary" disabled={!typed || !live || busy} onClick={save}>
              {busy ? "Saving…" : "Save secret"}
            </Button>
          </div>
          <Text as="p" size="xs" tone="quiet" className={cx(s.line)}>
            {`Sealed on this computer to ${target.machine}'s key. The hub only passes it on; fleetd never shows it again. To skip it, say so in the chat.`}
          </Text>
        </>
      )}
      <ErrorLine text={error} />
    </section>
  );
}

function ApprovalItem({ item }: { item: CommandApprovalItem }) {
  const live = useLive();
  const { call } = useDataLayer();
  const { shown, busy, error, run } = useSent(item);
  const outcome = approvalOutcome(shown);
  const env = secretEnvLine(item);
  const answer = (approve: boolean): void =>
    run(async () => {
      const out = await call("approval_answer", { requestId: item.requestId, approve });
      return out.ok ? { ok: true, sent: { state: approve ? "approved" : "denied" } } : out;
    });
  return (
    <section className={s.item} data-request={item.requestId} aria-label="Command to approve">
      <div className={s.head}>
        <Text size="xs" tone="quiet" strong>
          {item.argv === undefined ? "Permission" : "Command"}
        </Text>
        <Text size="xs" tone={item.class === "credential" ? "warning" : "danger"} strong>
          {classWords(item.class)}
        </Text>
      </div>
      <Text as="p" strong className={cx(s.title)}>
        {prose(item.reason)}
      </Text>
      <div className={s.detail}>
        {item.argv === undefined ? (
          <>
            {item.tool === undefined ? null : (
              <Text size="xs" tone="quiet">
                {item.tool}
              </Text>
            )}
            {item.inputSummary === undefined ? null : <Code code={item.inputSummary} bare />}
          </>
        ) : (
          <Code code={shellLine(item.argv)} lang="sh" bare />
        )}
        <Text size="xs" tone="quiet">
          on {item.machineId}
          {item.cwd === undefined ? null : (
            <>
              {" "}
              in <InlineCode>{item.cwd}</InlineCode>
            </>
          )}
          {item.timeoutSec === undefined ? null : ` · stops after ${String(Math.ceil(item.timeoutSec / 60))} min`}
        </Text>
        {env === undefined ? null : (
          <Text size="xs" tone="quiet">
            {prose(env)}
          </Text>
        )}
      </div>
      {outcome === undefined ? null : <OutcomeLine outcome={outcome} />}
      {item.outputTail === undefined || item.outputTail.trim() === "" ? null : <Code code={item.outputTail} bare />}
      {shown.state === "open" ? (
        <div className={s.actions}>
          <Button variant={item.class === "irreversible" ? "danger" : "primary"} disabled={!live || busy} onClick={() => answer(true)}>
            Approve
          </Button>
          <Button variant="secondary" disabled={!live || busy} onClick={() => answer(false)}>
            Deny
          </Button>
        </div>
      ) : null}
      <ErrorLine text={error} />
    </section>
  );
}
