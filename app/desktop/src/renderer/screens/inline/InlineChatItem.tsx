// The only two things in a lead chat that aren't messages, because a message can't carry them safely: a secret the
// person types (it never enters the transcript) and a risky command the person approves or denies. F3's chat list
// renders this for a message with an `item`. The item comes from E1's layer, which re-reads it when the hub
// re-emits its chat.message; the only state here is what the person just did, until that update says the same.
import { useMemo, useRef, useState } from "react";
import type { ChatItem, CommandApprovalItem, Machine, SecretRequestItem } from "../../../shared/contracts";
import type { HubError } from "../../../shared/hub";
import { Button, Code, cx, InlineCode, Input, Text } from "../../ui";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { prose } from "./prose";
import { approvalKind, approvalOutcome, classWords, secretEnvLines, secretOutcome, secretTarget, shellLine, withRequest, type Outcome } from "./request";
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

/** Every request the hub holds, newest first; one read shared by all the items, refetched on request.* events. */
const REQUESTS = { limit: 100 } as const;

export function InlineChatItem({ item: posted }: { item: ChatItem }) {
  const requests = useToolQuery("requests_list", REQUESTS);
  const item = withRequest(posted, requests.data?.requests.find((r) => r.requestId === posted.requestId));
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
      {item.note === undefined || item.note.trim() === "" ? null : (
        <Text as="p" size="sm" tone="quiet" className={cx(s.line)}>
          {prose(item.note)}
        </Text>
      )}
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
  const { gated, permission, playbook } = item;
  const kind = approvalKind(item);
  const [showDiff, setShowDiff] = useState(false);
  const answer = (decision: "approve" | "deny"): void =>
    run(async () => {
      const out = await call("approval_answer", { requestId: item.requestId, decision });
      return out.ok ? { ok: true, sent: { state: decision === "approve" ? "approved" : "denied" } } : out;
    });
  return (
    <section className={s.item} data-request={item.requestId} aria-label="Command to approve">
      <div className={s.head}>
        <Text size="xs" tone="quiet" strong>
          {kind === "playbook" ? "Playbook change" : kind === "command" ? "Command" : "Permission"}
        </Text>
        {kind === "playbook" ? (
          <Text size="xs" tone="warning" strong>
            Relaxes a gate
          </Text>
        ) : null}
        {gated === undefined ? null : (
          <Text size="xs" tone={gated.class === "credential" ? "warning" : "danger"} strong>
            {classWords(gated.class)}
          </Text>
        )}
      </div>
      <Text as="p" strong className={cx(s.title)}>
        {playbook !== undefined
          ? playbook.summary
          : gated !== undefined
          ? prose(gated.reason)
          : permission !== undefined
            ? `An agent wants to use ${permission.toolName}`
            : "An agent needs your OK"}
      </Text>
      {playbook === undefined ? null : (
        <div className={s.detail}>
          <div>
            <Button variant="quiet" aria-expanded={showDiff} onClick={() => setShowDiff((v) => !v)}>
              {showDiff ? "Hide the change" : "Show the change"}
            </Button>
          </div>
          {showDiff ? <Code code={playbook.diff} lang="diff" bare /> : null}
          <Text size="xs" tone="quiet">
            This loosens a gate for every project. It applies only if you approve.
          </Text>
        </div>
      )}
      {playbook !== undefined ? null : (
        <div className={s.detail}>
          {gated !== undefined ? <Code code={shellLine(gated.argv)} lang="sh" bare /> : null}
          {gated === undefined && permission !== undefined ? <Code code={permission.summary} bare /> : null}
          <Text size="xs" tone="quiet">
            on {item.machineId}
            {gated?.cwd === undefined ? null : (
              <>
                {" "}
                in <InlineCode>{gated.cwd}</InlineCode>
              </>
            )}
            {gated === undefined ? null : ` · stops after ${String(Math.ceil(gated.timeoutSec / 60))} min`}
          </Text>
          {gated === undefined
            ? null
            : secretEnvLines(gated).map((line) => (
                <Text key={line} size="xs" tone="quiet">
                  {prose(line)}
                </Text>
              ))}
        </div>
      )}
      {/* Why it is open again (approved while the node was offline) or why it failed. */}
      {item.note === undefined || item.note.trim() === "" ? null : (
        <p className={s.outcome}>
          <Text size="sm" tone={shown.state === "open" ? "warning" : "quiet"}>
            {prose(item.note)}
          </Text>
        </p>
      )}
      {outcome === undefined ? null : <OutcomeLine outcome={outcome} />}
      {item.outputTail === undefined || item.outputTail.trim() === "" ? null : <Code code={item.outputTail} bare />}
      {shown.state === "open" ? (
        <div className={s.actions}>
          <Button variant={gated?.class === "irreversible" ? "danger" : "primary"} disabled={!live || busy} onClick={() => answer("approve")}>
            {item.note === undefined ? "Approve" : "Approve again"}
          </Button>
          <Button variant="secondary" disabled={!live || busy} onClick={() => answer("deny")}>
            Deny
          </Button>
        </div>
      ) : null}
      <ErrorLine text={error} />
    </section>
  );
}
