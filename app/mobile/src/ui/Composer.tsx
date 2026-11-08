// The composer, as iOS 26's Messages draws it: floating over the thread in Liquid Glass, an attach button
// (photos, the camera, files; iOS's own menu on iOS 26, MenuButton) beside a glass field that grows with the text, and a round send button inside it that
// shows once there is something to send. Picked files upload at once (upload.ts), each a thumbnail with its progress;
// a reply shows what it quotes above the field. Return makes a new line; the button sends. While the lead works and
// nothing is written, the button is Stop, as ChatGPT's and the desktop's. What's in it is the chat's draft
// (draftsStore.ts): it stays when you leave the chat, and when the app starts again.
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { useEffect, useLayoutEffect, useRef, type ComponentRef } from "react";
import { Alert, Image, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type LayoutChangeEvent } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import type { AttachmentRef } from "../desktop";
import { emptyDraft, expired, sendSlot, type DraftFile, type DraftReply } from "../drafts";
import { useDraft } from "../draftsStore";
import type { Key } from "../store";
import { space, type, useTheme } from "../theme";
import { mimeOf, pickedName, refusal, type Uploaded } from "../upload";
import { Glass, GlassGroup } from "./Glass";
import { haptics } from "./haptics";
import { afterMenu } from "./HoldMenu";
import { Icon } from "./Icon";
import { MenuButton } from "./MenuButton";
import { grows, quick, useReduceMotion } from "./motion";

export type Upload = (bytes: Uint8Array, name: string, mime: NonNullable<ReturnType<typeof mimeOf>>, progress: (done: number) => void) => Promise<Uploaded>;

interface Picked {
  readonly uri: string;
  readonly name: string;
  readonly type: string | undefined;
  readonly image: boolean;
}

let nextId = Date.now();

export function Composer({
  chatKey,
  onSend,
  upload,
  bottomInset,
  onStop,
  onHeight,
  placeholder = "Message",
}: {
  /** The chat whose draft this is: what's written, picked and quoted, kept here so typing draws only the composer. */
  chatKey: Key;
  /** The words, the files the hub has, and the bubble they reply to. */
  onSend: (text: string, files: readonly AttachmentRef[], reply: DraftReply | undefined) => void;
  upload: Upload;
  bottomInset: number;
  /** While the lead works: Stop in the send button's place, until something is written. */
  onStop?: (() => void) | undefined;
  /** The composer's height, for the thread to keep its last bubble clear of it. */
  onHeight?: (height: number) => void;
  placeholder?: string;
}) {
  const t = useTheme();
  const reduce = useReduceMotion();
  const [draft, onDraft] = useDraft(chatKey);
  const { text, files, reply } = draft;
  const setText = (next: string) => onDraft((d) => ({ ...d, text: next }));
  const setFiles = (change: (now: readonly DraftFile[]) => readonly DraftFile[]) => onDraft((d) => ({ ...d, files: change(d.files) }));
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const slot = sendSlot(draft, onStop !== undefined);
  const ready = slot === "send";
  const stop = slot === "stop";

  // The send button shows as the first letter is typed, on the snap curve; no bounce.
  const shown = useSharedValue(0);
  useEffect(() => {
    shown.value = withTiming(ready || stop ? 1 : 0, { ...quick, duration: reduce ? 0 : quick.duration });
  }, [ready, stop, reduce, shown]);
  const sendStyle = useAnimatedStyle(() => ({ opacity: shown.value, transform: [{ scale: 0.6 + 0.4 * shown.value }] }));

  // A quote comes in the same frame as the thread makes room for it: as it comes or goes, the height is read as it's
  // laid out, not frames later from onLayout, which the menu still going away holds up. onLayout follows the rest.
  const bar = useRef<ComponentRef<typeof View>>(null);
  const quoting = reply !== undefined;
  useLayoutEffect(() => {
    const height = bar.current?.getBoundingClientRect().height;
    if (height !== undefined && height > 0) onHeight?.(height);
  }, [quoting]);

  // A reply picked now brings the keyboard up, once its menu has gone; one the draft held when the chat opened doesn't.
  const replyAtOpen = useRef(reply);
  useEffect(() => {
    if (reply !== undefined && reply !== replyAtOpen.current) afterMenu(() => input.current?.focus());
  }, [reply]);

  const send = () => {
    if (!ready) return;
    // An upload the hub has deleted since (a draft left overnight) asks to be attached again, as one it refused.
    const fresh = expired(draft, Date.now());
    if (fresh !== draft) onDraft((d) => expired(d, Date.now()));
    const go = () => {
      haptics.tap();
      onSend(text, fresh.files.flatMap((f) => (f.ref === undefined ? [] : [f.ref])), fresh.reply);
      onDraft(() => emptyDraft);
    };
    // A file the hub didn't take never goes quietly: the message waits for a yes.
    const failed = fresh.files.filter((f) => f.error !== undefined);
    if (failed.length === 0) return go();
    haptics.warning();
    const title = failed.length === 1 ? `${failed[0]?.name ?? "A file"} wasn't attached` : `${String(failed.length)} files weren't attached`;
    const why = failed.map((f) => f.error).join("\n");
    // Nothing left to send without them: the draft stays as it is, to attach them again.
    if (sendSlot(fresh, false) !== "send") return Alert.alert(title, why);
    Alert.alert(title, `${why}\n\nSend the message without ${failed.length === 1 ? "it" : "them"}?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Send", onPress: go },
    ]);
  };

  const set = (id: number, change: Partial<DraftFile>) => setFiles((now) => now.map((f) => (f.id === id ? { ...f, ...change } : f)));
  const attach = (picked: readonly Picked[]) => {
    for (const p of picked) {
      const id = ++nextId;
      const mime = mimeOf(p.name, p.type);
      setFiles((now) => [...now, { id, name: p.name, image: p.image ? p.uri : undefined, progress: 0 }]);
      void (async () => {
        try {
          const bytes = await new File(p.uri).bytes();
          const why = refusal(p.name, mime, bytes.length);
          if (why !== undefined || mime === undefined) return set(id, { error: why ?? `${p.name} can't be sent.` });
          const r = await upload(bytes, p.name, mime, (done) => set(id, { progress: done }));
          set(id, r.ok ? { ref: r.ref, progress: 1, uploadedAt: Date.now() } : { error: r.message });
          if (!r.ok) haptics.warning();
        } catch {
          set(id, { error: `${p.name} couldn't be read.` });
        }
      })();
    }
  };

  // Typed by its name, which pickedName makes match what the picker wrote: a library HEIC comes back as a JPEG.
  const photo = (a: ImagePicker.ImagePickerAsset): Picked => ({ uri: a.uri, name: pickedName(a.fileName, a.uri, `photo-${String(++nextId)}.jpg`), type: undefined, image: true });
  const pickPhotos = async () => {
    // Compatible: a HEIC comes as a JPEG, which the hub takes.
    const r = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      selectionLimit: 10,
      quality: 0.85,
      preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    });
    if (!r.canceled) attach(r.assets.map(photo));
  };
  const takePhoto = async () => {
    const allowed = await ImagePicker.requestCameraPermissionsAsync();
    if (!allowed.granted) return Alert.alert("fleetd can't use the camera", "Allow it in Settings › fleetd › Camera.");
    try {
      const r = await ImagePicker.launchCameraAsync({ quality: 0.85 });
      if (!r.canceled) attach(r.assets.map(photo));
    } catch {
      Alert.alert("No camera", "This device has no camera to take a photo with.");
    }
  };
  const pickFiles = async () => {
    const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    if (!r.canceled) attach(r.assets.map((a) => ({ uri: a.uri, name: a.name, type: a.mimeType, image: a.mimeType?.startsWith("image/") === true })));
  };

  return (
    <View ref={bar} style={[styles.bar, { paddingBottom: Math.max(bottomInset, space.sm) }]} onLayout={(e: LayoutChangeEvent) => onHeight?.(e.nativeEvent.layout.height)}>
      {reply === undefined ? null : (
        <Glass style={styles.reply}>
          <View style={[styles.replyRule, { backgroundColor: t.accent }]} />
          <View style={styles.grow}>
            <Text style={[type.footnote, styles.strong, { color: t.accent }]} numberOfLines={1}>
              Reply to {reply.who}
            </Text>
            <Text style={[type.footnote, { color: t.secondary }]} numberOfLines={1}>
              {reply.quote}
            </Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Cancel reply" hitSlop={10} onPress={() => onDraft((d) => ({ ...d, reply: undefined }))}>
            <Icon name="close" size={14} color={t.secondary} weight="semibold" />
          </Pressable>
        </Glass>
      )}
      <GlassGroup style={styles.row} spacing={10}>
        <MenuButton
          icon="plus"
          label="Attach"
          hint="Photos, the camera or a file"
          size={44}
          items={[
            { label: "Photos", icon: "photos", presents: true, onPress: () => void pickPhotos() },
            { label: "Camera", icon: "takePhoto", presents: true, onPress: () => void takePhoto() },
            { label: "File", icon: "file", presents: true, onPress: () => void pickFiles() },
          ]}
        />
        <Animated.View {...grows(reduce)} style={styles.grow}>
          <Glass style={styles.field}>
            {files.length === 0 ? null : (
              // Not iOS's status-bar tap: the chat's StatusBarTap takes it, and two that would make it do nothing.
              <ScrollView horizontal scrollsToTop={false} showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tray} keyboardShouldPersistTaps="handled">
                {files.map((f) => (
                  <Thumb key={f.id} file={f} onRemove={() => setFiles((now) => now.filter((x) => x.id !== f.id))} />
                ))}
              </ScrollView>
            )}
            <View style={styles.inputRow}>
              <TextInput
                ref={input}
                style={[type.body, styles.input, { color: t.label }]}
                selectionColor={t.accent}
                value={text}
                onChangeText={setText}
                placeholder={placeholder}
                placeholderTextColor={t.secondary}
                multiline
                {...(Platform.OS === "web" ? { rows: 1 } : {})}
                accessibilityLabel="Message"
                keyboardAppearance={t.dark ? "dark" : "light"}
              />
              <Animated.View style={[styles.sendSlot, sendStyle]} pointerEvents={ready || stop ? "auto" : "none"}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={stop ? "Stop" : "Send"}
                  {...(stop ? { accessibilityHint: "Stops what the lead is doing now" } : {})}
                  accessibilityElementsHidden={!ready && !stop}
                  importantForAccessibility={ready || stop ? "yes" : "no-hide-descendants"}
                  onPress={stop ? onStop : send}
                  hitSlop={8}
                  style={({ pressed }) => [styles.send, { backgroundColor: stop ? t.label : t.accentFill }, pressed && styles.pressed]}
                >
                  {stop ? <View style={[styles.stopMark, { backgroundColor: t.bg }]} /> : <Icon name="send" size={16} color={t.onAccent} weight="bold" />}
                </Pressable>
              </Animated.View>
            </View>
          </Glass>
        </Animated.View>
      </GlassGroup>
    </View>
  );
}

/** A picked file in the tray: its picture or its name, a bar while it uploads, red when the hub didn't take it. */
function Thumb({ file, onRemove }: { file: DraftFile; onRemove: () => void }) {
  const t = useTheme();
  const busy = file.ref === undefined && file.error === undefined;
  const label = file.error ?? (busy ? `${file.name}, uploading, ${String(Math.round(file.progress * 100))} percent` : file.name);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Removes it"
      onPress={() => {
        if (file.error !== undefined) Alert.alert("Not attached", file.error);
        onRemove();
      }}
      style={[styles.thumb, { backgroundColor: t.fillQuiet }, file.image === undefined && styles.fileThumb]}
    >
      {file.image === undefined ? (
        <>
          <Icon name={file.name.toLowerCase().endsWith(".pdf") ? "pdf" : "file"} size={20} color={t.secondary} />
          <Text style={[type.caption, styles.grow, { color: t.label }]} numberOfLines={2}>
            {file.name}
          </Text>
        </>
      ) : (
        <Image source={{ uri: file.image }} style={StyleSheet.absoluteFill} />
      )}
      {busy ? (
        <View style={[styles.progressTrack, { backgroundColor: "rgba(0,0,0,0.25)" }]}>
          <View style={[styles.progress, { width: `${String(Math.max(6, Math.round(file.progress * 100)))}%`, backgroundColor: t.accentFill }]} />
        </View>
      ) : null}
      {file.error === undefined ? null : (
        <View style={[StyleSheet.absoluteFill, styles.failed, { backgroundColor: "rgba(0,0,0,0.45)" }]}>
          <Icon name="error" size={22} color="#FFFFFF" />
        </View>
      )}
      <View style={styles.remove}>
        <Icon name="close" size={9} color="#FFFFFF" weight="bold" />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: { paddingHorizontal: space.md, paddingTop: space.sm, gap: space.sm },
  row: { flexDirection: "row", alignItems: "flex-end", gap: space.sm },
  grow: { flex: 1 },
  field: { borderRadius: 22, borderCurve: "continuous", minHeight: 44, justifyContent: "center" },
  inputRow: { flexDirection: "row", alignItems: "flex-end", paddingLeft: space.lg, paddingRight: 6 },
  input: { flex: 1, maxHeight: 140, paddingTop: 11, paddingBottom: 11, marginRight: space.xs },
  sendSlot: { marginBottom: 6 },
  send: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  stopMark: { width: 11, height: 11, borderRadius: 2.5 },
  pressed: { opacity: 0.6 },
  strong: { fontWeight: "600" },
  reply: { flexDirection: "row", alignItems: "center", gap: space.md, borderRadius: 18, borderCurve: "continuous", paddingVertical: space.sm, paddingLeft: space.md, paddingRight: space.lg },
  replyRule: { width: 3, alignSelf: "stretch", borderRadius: 2 },
  tray: { gap: space.sm, paddingHorizontal: space.sm, paddingTop: space.sm },
  thumb: { width: 64, height: 64, borderRadius: 14, borderCurve: "continuous", overflow: "hidden" },
  fileThumb: { width: 132, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: space.sm },
  progressTrack: { position: "absolute", left: 6, right: 6, bottom: 6, height: 4, borderRadius: 2, overflow: "hidden" },
  progress: { height: 4, borderRadius: 2 },
  failed: { alignItems: "center", justifyContent: "center" },
  remove: { position: "absolute", top: 4, right: 4, width: 18, height: 18, borderRadius: 9, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center" },
});
