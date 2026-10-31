// A Navi's Telegram (its Projects page, only for a project of kind assistant; W237): a guided setup in the first-run
// steps' style (setup/Guide.tsx). 1 make a bot with @BotFather, the exact messages to send it; 2 paste the token it
// gives, which main seals to the Navi's machine (telegram_set) and the page never gets back; 3 Test, the bot's name
// and photo as Telegram answers (telegram_test); 4 Pair, which opens t.me/<bot>?start=<code> (telegram_pair) and waits
// for the person's Start. Once paired: the bot, who it answers, the bridge's status, Pause, Unpair and Remove.
import { Check, ExternalLink, Send } from "lucide-react";
import { useEffect, useState } from "react";
import type { TelegramBot, TelegramBridge } from "../../../shared/contracts";
import { lacksTool } from "../../src/data/errors";
import { CallError } from "../../src/data/queries";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { Avatar, Button, Dot, Field, InlineCode, Input, Text } from "../../ui";
import { Part, Values } from "../setup/Guide";
import { ConfirmRemove, Problem, TestButton } from "./claudeParts";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import { Setting } from "./parts";
import { BOTFATHER, statusWords, stepOf, suggestedUsername, type StatusWords } from "./telegramModel";
import s from "./settings.module.css";

type Ref = { machineId: string; projectId: string };

/** Test asks Telegram twice and fetches the bot's photo. */
const TEST_MS = 60_000;
/** While a pairing link waits, the page asks how it stands this often. */
const PAIR_POLL_MS = 2000;

const open = (url: string): void => void window.fleetd.openExternal(url);

const HELP =
  "Talk to this Navi from Telegram, with a bot of your own that answers only you. Its replies and approvals reach you there too; the bot's token stays sealed on its machine.";

export function TelegramSetting({ projectRef }: { projectRef: Ref }) {
  const live = useLive();
  const read = useToolQuery("telegram_get", { navi: projectRef }, { enabled: live });
  if (!live) {
    return (
      <Setting reveal="projects.telegram" label="Telegram" help={HELP}>
        <Text size="sm" tone="quiet">
          Not connected. Connect to a hub to set up Telegram.
        </Text>
      </Setting>
    );
  }
  if (read.error instanceof CallError && lacksTool(read.error.error)) {
    return (
      <Setting reveal="projects.telegram" label="Telegram" help={HELP}>
        <Text size="sm" tone="quiet">
          This hub is too old for Telegram. Update fleetd on the hub first.
        </Text>
      </Setting>
    );
  }
  if (read.data === undefined) {
    return (
      <Setting reveal="projects.telegram" label="Telegram" help={HELP}>
        <Text size="sm" tone={read.isLoadingError ? "danger" : "quiet"}>
          {read.isLoadingError ? errorText(read.error) : "Loading…"}
        </Text>
      </Setting>
    );
  }
  return (
    <Setting reveal="projects.telegram" label="Telegram" help={HELP}>
      <Bridge projectRef={projectRef} bridge={read.data.bridge} />
    </Setting>
  );
}

function useNavi(ref: Ref) {
  const title = useData((d) => d.projects[`${ref.machineId}/${ref.projectId}`]?.title) ?? "Navi";
  const machine = useData((d) => d.machines[ref.machineId]);
  return {
    title,
    machine: machine?.name ?? ref.machineId,
    box: typeof machine?.boxPubKey === "string" ? { machineId: ref.machineId, boxPubKey: machine.boxPubKey } : undefined,
  };
}

function Bridge({ projectRef, bridge }: { projectRef: Ref; bridge: TelegramBridge | undefined }) {
  const step = stepOf(bridge);
  const [replacing, setReplacing] = useState(false);
  if (step === "done" && bridge !== undefined && !replacing) return <Paired projectRef={projectRef} bridge={bridge} onReplace={() => setReplacing(true)} />;
  return (
    <Steps
      projectRef={projectRef}
      bridge={replacing ? undefined : bridge}
      onSaved={() => setReplacing(false)}
      {...(replacing ? { onCancel: () => setReplacing(false) } : {})}
    />
  );
}

/**
 * One numbered step: open, its number a check once done (folded to its one line, or what it found), or still ahead
 * (one faint line on what it does).
 */
function Step(props: { n: number; title: string; done: boolean; open: boolean; ahead?: string; summary?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div data-step={props.n} data-done={props.done ? "" : undefined}>
      <Part n={props.n} title={props.title}>
        {props.open ? (
          props.children
        ) : props.done ? (
          typeof props.summary === "string" ? (
            <span className={s.telegramDone}>
              <Check size={14} aria-label="Done" />
              <Text size="sm" tone="quiet">
                {props.summary}
              </Text>
            </span>
          ) : (
            props.summary
          )
        ) : props.ahead === undefined ? null : (
          <Text size="sm" tone="faint">
            {props.ahead}
          </Text>
        )}
      </Part>
    </div>
  );
}

/**
 * The steps until an account is paired. With a token saved, it can be replaced (a field to paste a new one) or removed
 * at any step, so a token Telegram refuses at Test is never a dead end. `onCancel`, from the paired view's Replace
 * token, goes back to it.
 */
function Steps({ projectRef, bridge, onSaved, onCancel }: { projectRef: Ref; bridge: TelegramBridge | undefined; onSaved: () => void; onCancel?: () => void }) {
  const navi = useNavi(projectRef);
  const step = stepOf(bridge);
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const { hub } = useDataLayer();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<{ bot?: TelegramBot | undefined; error?: string | undefined }>();
  const [pasting, setPasting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const pasteOpen = step === 1 || pasting;
  const username = suggestedUsername(navi.title);
  const test = async () => {
    setTesting(true);
    const out = await hubCall("telegram_test", { navi: projectRef }, { timeoutMs: TEST_MS }).then(
      (t) => ({ bot: t.bot, error: t.error }),
      (e: unknown) => ({ error: errorText(e) }),
    );
    setTesting(false);
    setTested(out);
    refetch(["telegram_get"]);
  };
  const save = async () => {
    if (navi.box === undefined) {
      setProblem(`${navi.machine} takes no secrets yet: update fleetd there, then save.`);
      return;
    }
    setBusy(true);
    setProblem(null);
    const out = await window.fleetd.secret.telegram(hub, { navi: projectRef, token, box: navi.box }).catch((e: unknown) => ({ ok: false as const, problem: errorText(e) }));
    setBusy(false);
    if (!out.ok) {
      setProblem("problem" in out ? out.problem : errorText(new CallError(out.error)));
      return;
    }
    setToken("");
    setPasting(false);
    setTested(undefined);
    onSaved();
    refetch(["telegram_get"]);
    await test();
  };
  const bot = tested?.bot ?? bridge?.bot;
  return (
    <div className={s.telegramSteps} data-telegram-step={step}>
      <Step n={1} title="Make a bot with @BotFather" done={step !== 1} open={step === 1} summary="Bot made.">
        <Text as="p" size="sm" tone="quiet">
          Open @BotFather in Telegram and send it these, one at a time. It answers each one.
        </Text>
        <div className={s.inline}>
          <Button icon={<ExternalLink size={14} />} onClick={() => open(BOTFATHER)}>
            Open @BotFather
          </Button>
        </div>
        <Values
          values={[
            { label: "Send", value: "/newbot" },
            { label: "Its name", value: navi.title, note: "What Telegram shows at the top of the chat." },
            { label: "Its username", value: username, note: "It must end in bot. If it's taken, add a number before _bot." },
          ]}
        />
        <Text as="p" size="sm" tone="quiet">
          It answers with the bot&apos;s token, a line like <InlineCode>123456789:AAH…</InlineCode>. Copy it for the next step.
        </Text>
      </Step>
      <Step n={2} title="Paste the bot's token" done={step !== 1} open={pasteOpen} summary={`Sealed on ${navi.machine}.`}>
        <Field label="Token" description={`Sealed on this computer to ${navi.machine}: fleetd never shows it again, and it never goes in a chat.`}>
          <Input
            mono
            aria-label="Bot token"
            className={s.secretValue}
            data-secret=""
            value={token}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            placeholder="123456789:AAH…"
            onChange={(e) => setToken(e.target.value)}
          />
        </Field>
        <div className={s.inline}>
          <Button variant="primary" disabled={busy || token.trim() === ""} onClick={() => void save()}>
            {busy ? "Saving…" : "Save and test"}
          </Button>
          {pasting || onCancel !== undefined ? (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setPasting(false);
                setToken("");
                setProblem(null);
                onCancel?.();
              }}
            >
              Cancel
            </Button>
          ) : null}
        </div>
        <Problem text={problem} />
      </Step>
      <Step
        n={3}
        title="Test"
        done={bot !== undefined}
        open={step === 3 || (step === 4 && tested?.error !== undefined)}
        ahead="Asks Telegram which bot the token is: its name and photo."
        summary={bot === undefined ? undefined : <BotCard bot={bot} />}
      >
        <Text as="p" size="sm" tone="quiet">
          Asks Telegram which bot the token is.
        </Text>
        <div className={s.inline}>
          <TestButton testing={testing} onTest={() => void test()} />
        </div>
        {tested?.error !== undefined ? <Problem text={tested.error} /> : null}
      </Step>
      <Step n={4} title="Pair your Telegram" done={false} open={step === 4} ahead="One tap opens your bot; press Start there, and it answers only you.">
        <Pair projectRef={projectRef} bridge={bridge} />
      </Step>
      {bridge === undefined || pasting ? null : (
        <div className={s.inline} data-telegram-token>
          <Button size="sm" variant="ghost" disabled={busy || testing} onClick={() => (setPasting(true), setProblem(null))}>
            Replace token
          </Button>
          <Button size="sm" variant="ghost" disabled={busy || testing || bridge.offline === true} onClick={() => setRemoving(true)}>
            Remove
          </Button>
        </div>
      )}
      {removing ? (
        <ConfirmRemove
          title="Remove Telegram?"
          description={`${navi.machine} forgets the bot's token. The bot itself stays in Telegram until you delete it with @BotFather.`}
          action="Remove"
          onRemove={() => hubCall("telegram_remove", { navi: projectRef }).then(() => (setTested(undefined), refetch(["telegram_get"])))}
          onClose={() => setRemoving(false)}
        />
      ) : null}
    </div>
  );
}

function BotCard({ bot, words }: { bot: TelegramBot; words?: StatusWords | undefined }) {
  return (
    <div className={s.telegramBot} data-telegram-bot={bot.username}>
      <Avatar name={bot.name} navi={false} size={36} {...(bot.photo === undefined ? {} : { src: bot.photo })} />
      <div className={s.telegramBotName}>
        <Text size="sm" strong>
          {bot.name}
        </Text>
        <Text size="xs" tone="quiet">
          <Handle name={bot.username} />
        </Text>
      </div>
      {words === undefined ? null : (
        <span className={s.telegramStatus} data-telegram-status={words.word}>
          <Dot color={`var(--${words.tone === "quiet" ? "faint" : words.tone})`} />
          <Text size="xs" tone={words.tone === "success" ? "quiet" : words.tone}>
            {words.word}
          </Text>
        </span>
      )}
    </div>
  );
}

/** A Telegram @username, as written there: a name to copy, not words. */
function Handle({ name }: { name: string }) {
  return <span data-text="code">@{name}</span>;
}

/** Pair: one tap opens the bot with a one-time code; the page waits for the Start there. */
function Pair({ projectRef, bridge }: { projectRef: Ref; bridge: TelegramBridge | undefined }) {
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const waiting = link !== null && bridge?.paired === undefined;
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = setInterval(() => refetch(["telegram_get"]), PAIR_POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, refetch]);
  const pair = async () => {
    setBusy(true);
    setProblem(null);
    const out = await hubCall("telegram_pair", { navi: projectRef }).then(
      (p) => p.link,
      (e: unknown) => (setProblem(errorText(e)), null),
    );
    setBusy(false);
    if (out === null) return;
    setLink(out);
    open(out);
  };
  return (
    <>
      <Text as="p" size="sm" tone="quiet">
        Opens your bot in Telegram. Press Start there: your account becomes the only one this Navi answers. Anyone else who finds the bot gets no reply.
      </Text>
      <div className={s.inline}>
        <Button variant="primary" icon={<Send size={14} />} disabled={busy || bridge?.bot === undefined} onClick={() => void pair()}>
          {busy ? "Opening…" : link === null ? "Pair with Telegram" : "Open it again"}
        </Button>
      </div>
      {waiting ? (
        <div role="status" className={s.inline}>
          <Dot color="var(--warning)" />
          <Text size="sm" tone="quiet">
            Waiting for your Start in Telegram. The link works for 15 minutes.
          </Text>
        </div>
      ) : null}
      <Problem text={problem} />
    </>
  );
}

function Paired({ projectRef, bridge, onReplace }: { projectRef: Ref; bridge: TelegramBridge; onReplace: () => void }) {
  const navi = useNavi(projectRef);
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const words = statusWords(bridge, navi.machine);
  const act = (call: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    void call().then(
      () => (setBusy(false), refetch(["telegram_get"])),
      (e: unknown) => (setBusy(false), setProblem(errorText(e))),
    );
  };
  const paused = bridge.paused === true;
  return (
    <div className={s.stack} data-telegram-step="done">
      {bridge.bot === undefined ? null : <BotCard bot={bridge.bot} words={words} />}
      {bridge.paired === undefined ? null : (
        <Text size="sm">
          Answers {bridge.paired.name}
          {bridge.paired.username === undefined ? null : (
            <>
              {" "}
              (<Handle name={bridge.paired.username} />)
            </>
          )}{" "}
          only.{" "}
          {bridge.bot === undefined ? null : (
            <Button size="sm" variant="ghost" icon={<ExternalLink size={14} />} onClick={() => open(`https://t.me/${bridge.bot?.username ?? ""}`)}>
              Open in Telegram
            </Button>
          )}
        </Text>
      )}
      {words.line === undefined ? null : (
        <div role={words.tone === "danger" || words.tone === "warning" ? "alert" : "status"}>
          <Text size="sm" tone={words.tone === "danger" ? "danger" : "quiet"}>
            {words.line}
          </Text>
        </div>
      )}
      <div className={s.inline}>
        <Button size="sm" variant="ghost" disabled={busy || bridge.offline === true} onClick={() => act(() => hubCall("telegram_pause", { navi: projectRef, paused: !paused }))}>
          {paused ? "Resume" : "Pause"}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy || bridge.offline === true} onClick={() => act(() => hubCall("telegram_unpair", { navi: projectRef }))}>
          Unpair
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onReplace}>
          Replace token
        </Button>
        <Button size="sm" variant="ghost" disabled={busy || bridge.offline === true} onClick={() => setRemoving(true)}>
          Remove
        </Button>
      </div>
      <Problem text={problem} />
      {removing ? (
        <ConfirmRemove
          title="Remove Telegram?"
          description={`${navi.machine} forgets the bot's token, and Telegram no longer reaches ${navi.title}. The bot itself stays in Telegram until you delete it with @BotFather.`}
          action="Remove"
          onRemove={() => hubCall("telegram_remove", { navi: projectRef }).then(() => refetch(["telegram_get"]))}
          onClose={() => setRemoving(false)}
        />
      ) : null}
    </div>
  );
}
