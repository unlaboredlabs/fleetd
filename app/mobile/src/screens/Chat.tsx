// One Navi's or project's chat: newest at the bottom, older pages as you scroll up, the lead's text as it streams,
// approvals inline, and a box to write in. Messages written offline wait and go when the hub is back.
import { useMemo, useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { bubbles, sendNote } from "../chatView";
import { chatItems, emptyChat, type ChatItem } from "../desktop";
import type { Session } from "../session";
import type { Key, State } from "../store";
import { color, size } from "../theme";
import { Button } from "../ui";
import { ApprovalCard } from "./ApprovalCard";

export function Chat({ state, session, chatKey }: { state: State; session: Session; chatKey: Key }) {
  const [text, setText] = useState("");
  const chat = state.chats[chatKey] ?? emptyChat;
  const sends = state.sends[chatKey];
  const items = useMemo(() => chatItems(chat, sends ?? []), [chat, sends]);
  // An ask's buttons answer only while nothing of yours came after it.
  const lastHuman = items.findLastIndex((i) => i.author === "human");
  const newestFirst = useMemo(() => [...items].reverse(), [items]);

  const send = (body: string) => {
    if (body.trim() === "") return;
    session.send(chatKey, body);
  };

  return (
    <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <FlatList
        inverted
        data={newestFirst}
        keyExtractor={(i) => i.id}
        contentContainerStyle={styles.list}
        onEndReached={() => void session.loadOlder(chatKey)}
        ListFooterComponent={chat.loaded || chat.cached === true ? undefined : <Text style={styles.quiet}>Loading…</Text>}
        renderItem={({ item, index }) => (
          <Item
            item={item}
            state={state}
            session={session}
            chatKey={chatKey}
            canAnswer={items.length - 1 - index > lastHuman}
            onAnswer={send}
          />
        )}
      />
      {chat.error === undefined ? null : <Text style={styles.error}>{chat.error.message}</Text>}
      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder="Message"
          placeholderTextColor={color.faint}
          multiline
        />
        <Button
          label="Send"
          tone="accent"
          disabled={text.trim() === ""}
          onPress={() => {
            send(text);
            setText("");
          }}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

function Item({
  item,
  state,
  session,
  chatKey,
  canAnswer,
  onAnswer,
}: {
  item: ChatItem;
  state: State;
  session: Session;
  chatKey: Key;
  canAnswer: boolean;
  onAnswer: (text: string) => void;
}) {
  const inline = item.message?.item;
  if (inline?.kind === "command_approval") {
    const open = state.requests?.find((r) => r.requestId === inline.requestId);
    if (open !== undefined) {
      return (
        <ApprovalCard
          request={open}
          projectTitle={state.projects?.[chatKey]?.title}
          answering={state.answering[open.requestId] === true}
          error={state.answerErrors[open.requestId]}
          onAnswer={(d) => void session.answer(open.requestId, d)}
        />
      );
    }
    return <Text style={styles.event}>Approval {inline.state === "open" ? "waiting" : inline.state}</Text>;
  }
  if (inline?.kind === "secret_request") return <Text style={styles.event}>Asks for a secret: enter it in the desktop app.</Text>;
  if (item.kind === "event") return <Text style={styles.event}>{item.text}</Text>;

  if (item.author === "human") {
    const note = sendNote(item);
    const retry = item.state === "failed" || item.state === "unanswered";
    return (
      <Pressable disabled={!retry} onPress={() => session.resend(chatKey, item.id)} style={styles.mine}>
        <View style={styles.bubble}>
          <Text style={styles.text} selectable>
            {item.text}
          </Text>
        </View>
        {note === undefined ? null : <Text style={[styles.note, retry && { color: color.danger }]}>{note}</Text>}
      </Pressable>
    );
  }

  return (
    <View style={styles.theirs}>
      {item.author === "agent" ? <Text style={styles.note}>{item.message?.by ?? "Agent"}</Text> : null}
      {bubbles(item).map((b, i) =>
        b.kind === "text" ? (
          <Text key={i} style={styles.text} selectable>
            {b.text}
          </Text>
        ) : b.kind === "block" ? (
          <Text key={i} style={styles.event}>
            {b.text}
          </Text>
        ) : (
          <View key={i} style={styles.ask}>
            <Text style={styles.text}>{b.question}</Text>
            {canAnswer ? (
              <View style={styles.options}>
                {b.options.map((o) => (
                  <Button key={o} label={o} onPress={() => onAnswer(o)} />
                ))}
              </View>
            ) : null}
          </View>
        ),
      )}
      {item.state === "streaming" ? <Text style={styles.note}>Writing…</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  list: { padding: 12, gap: 12 },
  quiet: { color: color.quiet, fontSize: size.sm, textAlign: "center", padding: 12 },
  error: { color: color.danger, fontSize: size.sm, paddingHorizontal: 16, paddingVertical: 4 },
  event: { color: color.quiet, fontSize: size.xs, textAlign: "center" },
  mine: { alignSelf: "flex-end", maxWidth: "85%", alignItems: "flex-end", gap: 2 },
  bubble: { backgroundColor: color.bubble, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  theirs: { gap: 8 },
  text: { color: color.text, fontSize: size.md, lineHeight: 21 },
  note: { color: color.quiet, fontSize: size.xs },
  ask: { gap: 8, padding: 10, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: color.border },
  options: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    padding: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairline,
  },
  input: {
    flex: 1,
    maxHeight: 140,
    color: color.text,
    fontSize: size.md,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.raised,
  },
});
