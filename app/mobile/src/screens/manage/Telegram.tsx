// Telegram, pushed from a project's screen, as the desktop's Settings › Projects › Telegram once its bot is paired:
// the bot and who it answers, Open in Telegram, the bridge's status in the desktop's words, Pause or Resume, Unpair and
// Remove (asking first). Making the bot, pasting its token (sealed to its machine) and pairing are the desktop's
// guided setup, which this page points to until it is done.
import { useState } from "react";
import { ActivityIndicator, Linking, RefreshControl, ScrollView } from "react-native";
import { telegramWords, type HubError } from "../../desktop";
import { useHub, type ChatInfoProps } from "../../hubContext";
import { refOf } from "../../store";
import { space, useTheme, type Palette } from "../../theme";
import { haptics } from "../../ui/haptics";
import { ListRow, ListSection } from "../../ui/List";
import { readTelegram, telegramAct } from "./api";
import { machineName } from "./model";
import { confirmDestructive, errorWords, Note, Problem, useRead } from "./parts";

const HELP = "Talk to this project from Telegram, with a bot of your own that answers only you. Its replies and approvals reach you there too; the bot's token stays sealed on its machine.";

type Act = Parameters<typeof telegramAct>[2];

const toneColor = (t: Palette, tone: ReturnType<typeof telegramWords>["tone"]): string =>
  tone === "success" ? t.success : tone === "warning" ? t.warning : tone === "danger" ? t.danger : t.secondary;

export function Telegram({ route }: ChatInfoProps<"Telegram">) {
  const t = useTheme();
  const { state, session } = useHub();
  const key = route.params.key;
  const ref = refOf(key);
  const title = state.projects?.[key]?.title ?? "it";
  const machine = machineName(state.machines, ref.machineId);
  const read = useRead(() => readTelegram(session, ref), [session, key]);
  const [busy, setBusy] = useState<Act["t"] | null>(null);
  const [error, setError] = useState<HubError | null>(null);
  const live = state.hub.phase === "live";

  const act = async (a: Act) => {
    haptics.tap();
    setBusy(a.t);
    setError(null);
    const r = await telegramAct(session, ref, a);
    setBusy(null);
    if (!r.ok) {
      haptics.warning();
      setError(r.error);
    } else haptics.success();
    read.reload();
  };

  const spinner = <ActivityIndicator color={t.secondary} />;
  const result = read.value;
  const bridge = result?.ok === true ? result.value : undefined;
  const paired = bridge?.paired !== undefined && bridge.bot !== undefined;
  const words = bridge === undefined ? undefined : telegramWords(bridge, machine);
  const offline = bridge?.offline === true;
  const paused = bridge?.paused === true;
  const enabled = live && busy === null;
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: space.xxl }}
      style={{ backgroundColor: t.grouped }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={read.reload} tintColor={t.secondary} />}
    >
      {result === undefined ? (
        <ListSection footer={HELP}>
          <ListRow title="Reading…" accessory={spinner} />
        </ListSection>
      ) : !result.ok ? (
        <>
          <ListSection footer={HELP}>
            <ListRow title="Couldn't read its Telegram" />
          </ListSection>
          <Problem text={errorWords(result.error)} />
        </>
      ) : !paired || bridge === undefined || words === undefined ? (
        <ListSection footer={`${HELP} Set it up from this project's settings in the desktop app, which walks you through making the bot and pairing it.`}>
          <ListRow title="Telegram" value={bridge === undefined ? "Not set up" : "Not paired yet"} />
        </ListSection>
      ) : (
        <>
          <ListSection footer={words.line ?? HELP}>
            <ListRow title={bridge.bot?.name ?? "Bot"} detail={`@${bridge.bot?.username ?? ""}`} value={words.word} valueColor={toneColor(t, words.tone)} />
            <ListRow title="Answers" value={bridge.paired?.username === undefined ? bridge.paired?.name : `${bridge.paired.name} (@${bridge.paired.username})`} />
            <ListRow title="Open in Telegram" icon="paperplane" tint={t.tints[5]} chevron={false} onPress={() => void Linking.openURL(`https://t.me/${bridge.bot?.username ?? ""}`)} />
          </ListSection>
          <ListSection footer={paused ? "Paused: nothing is read or sent until you resume." : "Pause stops it reading and sending; what it says meanwhile stays in its chat."}>
            <ListRow
              title={paused ? "Resume" : "Pause"}
              chevron={false}
              {...(enabled && !offline ? { onPress: () => void act({ t: "pause", paused: !paused }) } : {})}
              {...(busy === "pause" ? { accessory: spinner } : {})}
            />
            <ListRow
              title="Unpair…"
              chevron={false}
              {...(enabled && !offline
                ? {
                    onPress: () =>
                      confirmDestructive({
                        title: "Unpair Telegram?",
                        message: `The bot stops answering ${bridge.paired?.name ?? "you"}. Pair again from the desktop app to use it.`,
                        button: "Unpair",
                        onConfirm: () => void act({ t: "unpair" }),
                      }),
                  }
                : {})}
              {...(busy === "unpair" ? { accessory: spinner } : {})}
            />
          </ListSection>
        </>
      )}
      {bridge === undefined ? null : (
        <ListSection>
          <ListRow
            title="Remove Telegram…"
            destructive
            chevron={false}
            {...(enabled && !offline
              ? {
                  onPress: () =>
                    confirmDestructive({
                      title: "Remove Telegram?",
                      message: `${machine} forgets the bot's token, and Telegram no longer reaches ${title}. The bot itself stays in Telegram until you delete it with @BotFather.`,
                      button: "Remove",
                      onConfirm: () => void act({ t: "remove" }),
                    }),
                }
              : {})}
            {...(busy === "remove" ? { accessory: spinner } : {})}
          />
        </ListSection>
      )}
      {offline ? <Note>{`${machine} is offline: Pause, Unpair and Remove wait until it's back.`}</Note> : null}
      <Problem text={error === null ? undefined : `Not done: ${errorWords(error)}`} />
    </ScrollView>
  );
}
