// The only two things in a lead chat that aren't messages, because a message can't carry them safely: a secret the
// person types (it never enters the transcript) and a risky command the person approves or denies. F3's chat list
// renders this for a message with an `item`. The item comes from E1's layer, which re-reads it when the hub
// re-emits its chat.message; the only state here is what the person just did, until the hub's next read of it.
// Once answered, an item folds to one line that opens back up to the whole card.
import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import type { ChatItem, CommandApprovalItem, Machine, SecretRequestItem } from "../../../shared/contracts";
import type { HubError } from "../../../shared/hub";
import { Button, Code, cx, InlineCode, Input, Text, Truncate } from "../../ui";
import { useData, useDataLayer, useReadOf, useToolQuery } from "../../src/data/react";
import { patchLocal, useLocal, type Failed } from "./local";
import { prose } from "./prose";
import {
  approvalOffline,
  approvalOutcome,
  approvalTitle,
  classWords,
  failureLine,
  needsConfirm,
  OFFLINE_LINE,
  secretEnvLines,
  secretOutcome,
  secretTarget,
  secretTitle,
  shellLine,
  withRequest,
  type Action,
  type Outcome,
} from "./request";
import s from "./InlineChatItem.module.css";

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
 * Main gives up on a hub call after 30 s (DEFAULT_CALL_TIMEOUT_MS); this only ends a wait whose answer never comes
 * back at all, such as a rejected IPC, so nothing says "Saving…" for ever.
 */
const ANSWER_TIMEOUT_MS = 35_000;

type Answer<T> = { ok: true; sent: Partial<T> } | { ok: false; error: Pick<HubError, "code"> };

const settled = <T,>(work: () => Promise<Answer<T>>): Promise<Answer<T>> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Answer<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: { code: "timeout" } }), ANSWER_TIMEOUT_MS);
  });
  const answered = work().catch((): Answer<T> => ({ ok: false, error: { code: "failed" } }));
  return Promise.race([answered, late]).finally(() => clearTimeout(timer));
};

/** Where this item's local state lives: per hub, since request ids count from Q1 on every hub. */
const useKey = (requestId: string): string => useData((d) => `${d.hub.phase === "unpaired" ? "" : d.hub.hub}/${requestId}`);

/**
 * What the person did (an answer the hub accepted, a failed one, an Approve waiting for its second key) bridges the
 * gap until the hub's truth arrives: the first requests read that went out after it landed. Once that read is in,
 * an accepted answer goes whatever the read says (approved, open again, failed), and a failure or a waiting Approve
 * goes unless the item is still open. A failure is one plain line, and only while the item is open.
 *
 * The controls are disabled while an answer is on its way, which drops keyboard focus; `refocus` says it was in the
 * card, so the folded line (or Retry) takes it back once the answer lands, and `focused` clears it.
 */
const useSent = <T extends { readonly state: string }>(key: string, item: T, read: number | undefined, machine: string, section: RefObject<HTMLElement | null>) => {
  const { readsStarted } = useDataLayer();
  const local = useLocal(key);
  const reread = read !== undefined && local.after !== null && read > local.after;
  const open = item.state === "open";
  const stale = reread && (local.sent !== null || (!open && (local.failed !== null || local.confirming)));
  useEffect(() => {
    if (stale) patchLocal(key, open ? { sent: null } : { sent: null, failed: null, confirming: false });
  }, [stale, open, key]);
  const shown: T = local.sent !== null && !reread ? { ...item, ...(local.sent as Partial<T>) } : item;
  const run = (action: Action, work: () => Promise<Answer<T>>): void => {
    patchLocal(key, { refocus: section.current?.contains(document.activeElement) ?? false, busy: true, failed: null, sent: null });
    void settled(work).then((out) => {
      const after = readsStarted();
      patchLocal(key, out.ok ? { busy: false, after, sent: out.sent } : { busy: false, after, failed: { action, failure: failureLine(action, out.error, machine) } });
    });
  };
  const setConfirming = (on: boolean): void => patchLocal(key, on ? { confirming: true, after: readsStarted() } : { confirming: false });
  const focused = (): void => patchLocal(key, { refocus: false });
  // Focus belongs to this row only while it is on screen: a row scrolled back into view never takes it.
  useEffect(() => () => patchLocal(key, { refocus: false }), [key]);
  return {
    local,
    shown,
    busy: local.busy,
    failed: shown.state === "open" ? local.failed : null,
    confirming: shown.state === "open" && local.confirming,
    setConfirming,
    run,
    refocus: local.refocus && !local.busy,
    focused,
  };
};

/** Every request the hub holds, newest first; one read shared by all the items, refetched on request.* events. */
const REQUESTS = { limit: 100 } as const;

export function InlineChatItem({ item: posted }: { item: ChatItem }) {
  const requests = useToolQuery("requests_list", REQUESTS);
  const listed = requests.data?.requests.find((r) => r.requestId === posted.requestId);
  const item = withRequest(posted, listed);
  // A read says something about this request only if it lists it (it holds the hub's newest 100).
  const read = useReadOf("requests_list", REQUESTS);
  return item.kind === "secret_request" ? <SecretItem item={item} read={listed === undefined ? undefined : read} /> : <ApprovalItem item={item} read={listed === undefined ? undefined : read} />;
}

/** An open item while there is no fresh connection: what is shown may be stale, and nothing can be answered. */
function OfflineLine({ text }: { text: string }) {
  return (
    <p className={s.outcome}>
      <Text size="sm" tone="quiet">
        {text}
      </Text>
    </p>
  );
}

/** An answered item's one line: what happened, then what it was about; a click opens the whole card. */
function Folded({ outcome, about, open, onToggle, focus, onFocused }: { outcome: Outcome; about: string; open: boolean; onToggle: () => void; focus: boolean; onFocused: () => void }) {
  const button = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!focus) return;
    button.current?.focus();
    onFocused();
  }, [focus, onFocused]);
  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <button ref={button} type="button" className={s.fold} aria-expanded={open} onClick={onToggle}>
      <Icon className={s.chevron} aria-hidden />
      <Text size="sm" tone={outcome.tone} className={cx(s.foldOutcome)}>
        {outcome.text}
      </Text>
      <Truncate size="sm" tone="quiet" expand="none" className={cx(s.foldAbout)}>
        {about}
      </Truncate>
    </button>
  );
}

function FailureLine({ failed, disabled, focus, onFocused, onRetry }: { failed: Failed | null; disabled: boolean; focus: boolean; onFocused: () => void; onRetry: () => void }) {
  const retry = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!focus || failed === null) return;
    retry.current?.focus();
    onFocused();
  }, [focus, failed, onFocused]);
  return failed === null ? null : (
    <div role="alert" className={s.failure}>
      <Text size="sm" tone="danger">
        {failed.failure.text}
      </Text>
      {failed.failure.retry ? (
        <Button ref={retry} variant="secondary" disabled={disabled} onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

/** The card, or once answered the folded line with the card under it when opened. */
function Shell({
  ref,
  label,
  requestId,
  outcome,
  about,
  refocus,
  onFocused,
  open,
  onToggle,
  onKeyDown,
  children,
}: {
  ref: RefObject<HTMLElement | null>;
  label: string;
  requestId: string;
  outcome: Outcome | undefined;
  about: string;
  refocus: boolean;
  onFocused: () => void;
  open: boolean;
  onToggle: () => void;
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void;
  children: ReactNode;
}) {
  if (outcome === undefined) {
    return (
      // Focusable from script (a jump to what the lead waits on), not a tab stop of its own: Tab reaches its controls.
      <section ref={ref} tabIndex={-1} className={s.item} data-request={requestId} aria-label={label} onKeyDown={onKeyDown}>
        {children}
      </section>
    );
  }
  return (
    <section ref={ref} className={s.answered} data-request={requestId} aria-label={label}>
      <Folded outcome={outcome} about={about} open={open} onToggle={onToggle} focus={refocus} onFocused={onFocused} />
      {open ? <div className={s.item}>{children}</div> : null}
    </section>
  );
}

function SecretItem({ item, read }: { item: SecretRequestItem; read: number | undefined }) {
  const machines = useMachines();
  const live = useLive();
  const target = secretTarget(machines, item, live);
  const section = useRef<HTMLElement>(null);
  const key = useKey(item.requestId);
  const { local, shown, busy, failed, run, refocus, focused } = useSent(key, item, read, target.ok ? target.machine : "the machine", section);
  const outcome = secretOutcome(shown);
  const draft = local.draft;
  // Answered here or elsewhere, or withdrawn: what was typed for it goes.
  useEffect(() => {
    if (outcome !== undefined && draft !== "") patchLocal(key, { draft: "" });
  }, [outcome, draft, key]);

  // The value goes from the field to main, which seals it, and is dropped here once the save succeeds; a failed save
  // keeps it, so Retry sends it again without pasting.
  const save = (): void => {
    if (!target.ok || !live || busy || draft === "") return;
    run("save", async () => {
      const out = await window.fleetd.secret.submit({ requestId: item.requestId, boxPubKey: target.boxPubKey, value: draft });
      if (!out.ok) return out;
      patchLocal(key, { draft: "" });
      return { ok: true, sent: { state: "stored", fingerprint: out.fingerprint } };
    });
  };

  return (
    <Shell ref={section} label="Secret for the lead" requestId={item.requestId} outcome={outcome} about={secretTitle(item)} refocus={refocus} onFocused={focused} open={local.open} onToggle={() => patchLocal(key, { open: !local.open })}>
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
      {outcome !== undefined ? null : "offline" in target ? (
        <OfflineLine text={OFFLINE_LINE.secret} />
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
              type="password"
              aria-label="Secret value"
              placeholder="Paste or type the value"
              autoComplete="off"
              className={cx(s.field)}
              disabled={!live || busy}
              value={draft}
              onChange={(e) => patchLocal(key, { draft: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  e.stopPropagation();
                  save();
                }
              }}
            />
            <Button variant="primary" disabled={draft === "" || !live || busy} onClick={save}>
              {busy ? "Saving…" : "Save secret"}
            </Button>
          </div>
          <FailureLine failed={failed} disabled={!live || busy} focus={refocus} onFocused={focused} onRetry={save} />
          <Text as="p" size="xs" tone="quiet" className={cx(s.line)}>
            {`Sealed on this computer to ${target.machine}'s key, so only ${target.machine} can open it. fleetd never shows it again. To skip it, say so in the chat.`}
          </Text>
        </>
      )}
    </Shell>
  );
}

/** A keydown from a control inside the card does what that control does: Enter on Deny denies. */
const fromControl = (e: KeyboardEvent<HTMLElement>): boolean =>
  e.target !== e.currentTarget && (e.target as HTMLElement).closest("button, input, textarea, select, a, [role=button]") !== null;

function ApprovalItem({ item, read }: { item: CommandApprovalItem; read: number | undefined }) {
  const live = useLive();
  const machines = useMachines();
  const { call } = useDataLayer();
  const machine = machines[item.machineId]?.name ?? item.machineId;
  const section = useRef<HTMLElement>(null);
  const key = useKey(item.requestId);
  const { local, shown, busy, failed, confirming, setConfirming, run, refocus, focused } = useSent(key, item, read, machine, section);
  const outcome = approvalOutcome(shown);
  const offline = approvalOffline(shown.state, live);
  const { gated, permission } = item;
  const confirm = useRef<HTMLDivElement>(null);
  const approveButton = useRef<HTMLButtonElement>(null);
  const canAnswer = live && !busy && shown.state === "open";

  const answer = (decision: "approve" | "deny"): void => {
    setConfirming(false);
    run(decision, async () => {
      const out = await call("approval_answer", { requestId: item.requestId, decision });
      return out.ok ? { ok: true, sent: { state: decision === "approve" ? "approved" : "denied" } } : out;
    });
  };
  // A command that can't be undone asks once more, in the card, before anything runs.
  const asked = useRef(false);
  const approve = (): void => {
    if (needsConfirm(item) && !confirming) {
      asked.current = true;
      setConfirming(true);
    } else answer("approve");
  };
  const cancelled = useRef(false);
  const cancel = (): void => {
    cancelled.current = true;
    setConfirming(false);
  };

  // The question takes focus, so its Enter is the second, deliberate key (a held Enter only repeats and is ignored);
  // Cancel hands focus back to Approve. A row that comes back into view with the question open never takes focus.
  useEffect(() => {
    if (confirming && asked.current) {
      asked.current = false;
      confirm.current?.focus();
    } else if (!confirming && cancelled.current) {
      cancelled.current = false;
      approveButton.current?.focus();
    }
  }, [confirming]);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.nativeEvent.isComposing || !canAnswer) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (confirming) cancel();
      else answer("deny");
    } else if (e.key === "Enter" && !fromControl(e)) {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) approve();
    }
  };

  const destructive = gated?.class === "irreversible";
  return (
    <Shell ref={section} label="Command to approve" requestId={item.requestId} outcome={outcome} about={approvalTitle(item)} refocus={refocus} onFocused={focused} open={local.open} onToggle={() => patchLocal(key, { open: !local.open })} onKeyDown={onKeyDown}>
      <div className={s.head}>
        <Text size="xs" tone="quiet" strong>
          {gated === undefined ? "Permission" : "Command"}
        </Text>
        {gated === undefined ? null : (
          <Text size="xs" tone={gated.class === "credential" ? "warning" : "danger"} strong>
            {classWords(gated.class)}
          </Text>
        )}
      </div>
      <Text as="p" strong className={cx(s.title)}>
        {gated !== undefined
          ? prose(gated.reason)
          : permission !== undefined
            ? `An agent wants to use ${permission.toolName}`
            : "An agent needs your OK"}
      </Text>
      <div className={s.detail}>
        {gated !== undefined ? <Code code={shellLine(gated.argv)} lang="sh" bare /> : null}
        {gated === undefined && permission !== undefined ? <Code code={permission.summary} bare /> : null}
        <Text size="xs" tone="quiet">
          on {machine}
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
      {/* Why it is open again (approved while the node was offline) or why it failed. */}
      {item.note === undefined || item.note.trim() === "" ? null : (
        <p className={s.outcome}>
          <Text size="sm" tone={shown.state === "open" ? "warning" : "quiet"}>
            {prose(item.note)}
          </Text>
        </p>
      )}
      {item.outputTail === undefined || item.outputTail.trim() === "" ? null : <Code code={item.outputTail} bare />}
      {offline === undefined ? null : <OfflineLine text={offline} />}
      <FailureLine failed={failed} disabled={!canAnswer} focus={refocus} onFocused={focused} onRetry={() => failed !== null && failed.action !== "save" && answer(failed.action)} />
      {shown.state !== "open" ? null : confirming ? (
        <div ref={confirm} tabIndex={-1} role="group" aria-labelledby={`${item.requestId}-confirm`} className={s.confirm}>
          <Text as="p" id={`${item.requestId}-confirm`} size="sm" tone="danger" strong className={cx(s.line)}>
            {`Run this on ${machine}? It can't be undone.`}
          </Text>
          <div className={s.actions}>
            <Button variant="danger" disabled={!canAnswer} onClick={() => answer("approve")}>
              Yes, run it
            </Button>
            <Button variant="secondary" disabled={!canAnswer} onClick={cancel}>
              Cancel
            </Button>
            <Text size="xs" tone="quiet">
              Enter runs · Esc cancels
            </Text>
          </div>
        </div>
      ) : (
        <div className={s.actions}>
          <Button ref={approveButton} variant={destructive ? "danger" : "primary"} disabled={!canAnswer} onClick={approve}>
            {item.note === undefined ? "Approve" : "Approve again"}
          </Button>
          <Button variant="secondary" disabled={!canAnswer} onClick={() => answer("deny")}>
            Deny
          </Button>
          <Text size="xs" tone="quiet" className={cx(s.whenFocused)}>
            Enter approves · Esc denies
          </Text>
        </div>
      )}
    </Shell>
  );
}
