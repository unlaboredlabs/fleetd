// The composer, as iOS 26's Messages and Telegram draw it: floating over the thread in Liquid Glass, an attach button
// (photos, the camera, files) beside a glass field that grows with the text, and a round send button inside it that
// shows once there is something to send. Picked files upload at once (upload.ts), each a thumbnail with its progress;
// a reply shows what it quotes above the field. Return makes a new line; the button sends.
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { useEffect, useRef, useState, type ComponentRef } from "react";
import { Alert, Image, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type LayoutChangeEvent } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import type { AttachmentRef } from "../desktop";
import { space, type, useTheme } from "../theme";
import { mimeOf, pickedName, refusal, type Uploaded } from "../upload";
import { Glass, GlassGroup } from "./Glass";
import { haptics } from "./haptics";
import { Icon } from "./Icon";
import { Menu, type Rect } from "./Menu";
import { grows, quick, useReduceMotion } from "./motion";

export type Upload = (bytes: Uint8Array, name: string, mime: NonNullable<ReturnType<typeof mimeOf>>, progress: (done: number) => void) => Promise<Uploaded>;

/** A file on its way into the message: a picture's own uri for its thumbnail, its progress, then the hub's reference. */
interface Attaching {
  readonly id: number;
  readonly name: string;
  readonly image: string | undefined;
  readonly progress: number;
  readonly ref?: AttachmentRef;
  readonly error?: string;
}

interface Picked {
  readonly uri: string;
  readonly name: string;
  readonly type: string | undefined;
  readonly image: boolean;
}

export interface Reply {
  /** Whose bubble it answers. */
  readonly who: string;
  readonly quote: string;
}

let nextId = Date.now();

export function Composer({
  onSend,
  upload,
  bottomInset,
  reply,
  onCancelReply,
  onHeight,
  placeholder = "Message",
}: {
  onSend: (text: string, files: readonly AttachmentRef[]) => void;
  upload: Upload;
  bottomInset: number;
  reply?: Reply | undefined;
  onCancelReply?: () => void;
  /** The composer's height, for the thread to keep its last bubble clear of it. */
  onHeight?: (height: number) => void;
  placeholder?: string;
}) {
  const t = useTheme();
  const reduce = useReduceMotion();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<readonly Attaching[]>([]);
  const [menu, setMenu] = useState<Rect | null>(null);
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const plus = useRef<ComponentRef<typeof View>>(null);
  const uploading = files.some((f) => f.ref === undefined && f.error === undefined);
  const ready = (text.trim() !== "" || files.some((f) => f.ref !== undefined)) && !uploading;

  // The send button shows as the first letter is typed, on the snap curve; no bounce.
  const shown = useSharedValue(0);
  useEffect(() => {
    shown.value = withTiming(ready ? 1 : 0, { ...quick, duration: reduce ? 0 : quick.duration });
  }, [ready, reduce, shown]);
  const sendStyle = useAnimatedStyle(() => ({ opacity: shown.value, transform: [{ scale: 0.6 + 0.4 * shown.value }] }));

  useEffect(() => {
    if (reply !== undefined) input.current?.focus();
  }, [reply]);

  const send = () => {
    if (!ready) return;
    const go = () => {
      haptics.tap();
      onSend(text, files.flatMap((f) => (f.ref === undefined ? [] : [f.ref])));
      setText("");
      setFiles([]);
    };
    // A file the hub didn't take never goes quietly: the message waits for a yes.
    const failed = files.filter((f) => f.error !== undefined);
    if (failed.length === 0) return go();
    haptics.warning();
    Alert.alert(
      failed.length === 1 ? `${failed[0]?.name ?? "A file"} wasn't attached` : `${String(failed.length)} files weren't attached`,
      `${failed.map((f) => f.error).join("\n")}\n\nSend the message without ${failed.length === 1 ? "it" : "them"}?`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Send", onPress: go },
      ],
    );
  };

  const set = (id: number, change: Partial<Attaching>) => setFiles((now) => now.map((f) => (f.id === id ? { ...f, ...change } : f)));
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
          set(id, r.ok ? { ref: r.ref, progress: 1 } : { error: r.message });
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
    <View style={[styles.bar, { paddingBottom: Math.max(bottomInset, space.sm) }]} onLayout={(e: LayoutChangeEvent) => onHeight?.(e.nativeEvent.layout.height)}>
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
          <Pressable accessibilityRole="button" accessibilityLabel="Cancel reply" hitSlop={10} onPress={onCancelReply}>
            <Icon name="close" size={14} color={t.secondary} weight="semibold" />
          </Pressable>
        </Glass>
      )}
      <GlassGroup style={styles.row} spacing={10}>
        <View ref={plus} collapsable={false}>
          <Glass interactive style={styles.circle}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Attach"
              accessibilityHint="Photos, the camera or a file"
              style={styles.circleHit}
              onPress={() => {
                haptics.tap();
                plus.current?.measureInWindow((x: number, y: number, width: number, height: number) => setMenu({ x, y, width, height }));
              }}
            >
              <Icon name="plus" size={20} color={t.label} weight="medium" />
            </Pressable>
          </Glass>
        </View>
        <Animated.View {...grows(reduce)} style={styles.grow}>
          <Glass style={styles.field}>
            {files.length === 0 ? null : (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tray} keyboardShouldPersistTaps="handled">
                {files.map((f) => (
                  <Thumb key={f.id} file={f} onRemove={() => setFiles((now) => now.filter((x) => x.id !== f.id))} />
                ))}
              </ScrollView>
            )}
            <View style={styles.inputRow}>
              <TextInput
                ref={input}
                style={[type.body, styles.input, { color: t.label }]}
                value={text}
                onChangeText={setText}
                placeholder={placeholder}
                placeholderTextColor={t.secondary}
                multiline
                {...(Platform.OS === "web" ? { rows: 1 } : {})}
                accessibilityLabel="Message"
                keyboardAppearance={t.dark ? "dark" : "light"}
              />
              <Animated.View style={[styles.sendSlot, sendStyle]} pointerEvents={ready ? "auto" : "none"}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Send"
                  accessibilityElementsHidden={!ready}
                  importantForAccessibility={ready ? "yes" : "no-hide-descendants"}
                  onPress={send}
                  hitSlop={8}
                  style={({ pressed }) => [styles.send, { backgroundColor: t.accent }, pressed && styles.pressed]}
                >
                  <Icon name="send" size={16} color="#FFFFFF" weight="bold" />
                </Pressable>
              </Animated.View>
            </View>
          </Glass>
        </Animated.View>
      </GlassGroup>
      <Menu
        above
        at={menu}
        onClose={() => setMenu(null)}
        items={[
          { label: "Photos", icon: "photos", presents: true, onPress: () => void pickPhotos() },
          { label: "Camera", icon: "takePhoto", presents: true, onPress: () => void takePhoto() },
          { label: "File", icon: "file", presents: true, onPress: () => void pickFiles() },
        ]}
      />
    </View>
  );
}

/** A picked file in the tray: its picture or its name, a bar while it uploads, red when the hub didn't take it. */
function Thumb({ file, onRemove }: { file: Attaching; onRemove: () => void }) {
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
          <View style={[styles.progress, { width: `${String(Math.max(6, Math.round(file.progress * 100)))}%`, backgroundColor: t.accent }]} />
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
  circle: { width: 44, height: 44, borderRadius: 22 },
  circleHit: { flex: 1, alignItems: "center", justifyContent: "center" },
  grow: { flex: 1 },
  field: { borderRadius: 22, borderCurve: "continuous", minHeight: 44, justifyContent: "center" },
  inputRow: { flexDirection: "row", alignItems: "flex-end", paddingLeft: space.lg, paddingRight: 6 },
  input: { flex: 1, maxHeight: 140, paddingTop: 11, paddingBottom: 11, marginRight: space.xs },
  sendSlot: { marginBottom: 6 },
  send: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
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
