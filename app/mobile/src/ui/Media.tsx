// What a message carries besides words: a picture, shown as itself with rounded corners as Messages does, which opens
// full screen to pinch, zoom and share; and any other file, as a card with its name and size that opens the share
// sheet (Save to Files, another app). Each is read from the hub once (attachment_get) as its bubble shows.
import { File, Paths } from "expo-file-system";
import { useEffect, useState } from "react";
import { Image, Modal, Pressable, ScrollView, Share, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { fileSize } from "../chatView";
import type { AttachmentGetOutput } from "../desktop";
import { useSession } from "../hubContext";
import type { Key } from "../store";
import { space, type, useTheme } from "../theme";
import { Glass } from "./Glass";
import { haptics } from "./haptics";
import { Icon } from "./Icon";
import { SkeletonBlock } from "./Skeleton";

/** A message's file, read from the hub; undefined while it comes, null when it couldn't be. */
export const useAttachment = (chatKey: Key, attachmentId: string): AttachmentGetOutput | null | undefined => {
  const session = useSession();
  const [got, setGot] = useState<AttachmentGetOutput | null | undefined>(undefined);
  useEffect(() => {
    let on = true;
    void session.attachment(chatKey, attachmentId).then((out) => {
      if (on) setGot(out);
    });
    return () => {
      on = false;
    };
  }, [session, chatKey, attachmentId]);
  return got;
};

const uriOf = (a: AttachmentGetOutput): string => `data:${a.mime};base64,${a.dataB64}`;

/** Shares a file as itself (its name and type), through iOS's share sheet. */
export const shareFile = async (a: AttachmentGetOutput): Promise<void> => {
  const file = new File(Paths.cache, a.name.replace(/[/\\]/gu, "-"));
  await file.write(a.dataB64, { encoding: "base64" });
  await Share.share({ url: file.uri });
};

const MAX_W = 240;

/** A picture in the thread: its own shape, at most 240 pt wide, a soft block while it loads. */
export function ImageBubble({ chatKey, attachmentId, name, onOpen, time }: { chatKey: Key; attachmentId: string; name: string; onOpen: (a: AttachmentGetOutput) => void; time?: string | undefined }) {
  const t = useTheme();
  const got = useAttachment(chatKey, attachmentId);
  const [aspect, setAspect] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (got === undefined || got === null) return;
    Image.getSize(uriOf(got), (w, h) => setAspect(w / h), () => setAspect(4 / 3));
  }, [got]);
  if (got === null)
    return (
      <View style={[styles.missing, { backgroundColor: t.fillQuiet }]}>
        <Icon name="photos" size={18} color={t.secondary} />
        <Text style={[type.footnote, { color: t.secondary }]}>{name} couldn't be read</Text>
      </View>
    );
  if (got === undefined || aspect === undefined) return <SkeletonBlock width={MAX_W} height={MAX_W * 0.75} radius={18} />;
  const width = aspect >= 1 ? MAX_W : Math.max(160, MAX_W * aspect * 1.2);
  const height = Math.min(320, Math.max(110, width / aspect));
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={`Photo, ${name}`}
      accessibilityHint="Opens it full screen"
      onPress={() => onOpen(got)}
    >
      {({ pressed }) => (
        <View>
          <Image source={{ uri: uriOf(got) }} style={[styles.image, { width, height, backgroundColor: t.fillQuiet }, pressed && styles.pressed]} resizeMode="cover" />
          {time === undefined ? null : (
            <View style={styles.imageTime}>
              <Text style={[type.caption2, styles.imageTimeText]} maxFontSizeMultiplier={1.4}>
                {time}
              </Text>
            </View>
          )}
        </View>
      )}
    </Pressable>
  );
}

/** Any other file: its kind, name and size; tapping shares it (Save to Files, Quick Look in another app). */
export function FileBubble({ chatKey, attachmentId, name, mime, bytes, mine, time }: { chatKey: Key; attachmentId: string; name: string; mime: string; bytes: number; mine: boolean; time?: string | undefined }) {
  const t = useTheme();
  const got = useAttachment(chatKey, attachmentId);
  const ink = mine ? t.onAccent : t.label;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`File, ${name}, ${fileSize(bytes)}`}
      accessibilityHint="Shares or saves it"
      disabled={got === undefined || got === null}
      onPress={() => {
        if (got === undefined || got === null) return;
        haptics.tap();
        void shareFile(got).catch(() => undefined);
      }}
      style={({ pressed }) => [styles.file, { backgroundColor: mine ? t.accent : t.bubble }, pressed && styles.pressed]}
    >
      <View style={[styles.fileIcon, { backgroundColor: mine ? "rgba(255,255,255,0.22)" : t.accent }]}>
        <Icon name={mime === "application/pdf" ? "pdf" : "file"} size={18} color="#FFFFFF" />
      </View>
      <View style={styles.fileText}>
        <Text style={[type.subhead, styles.strong, { color: ink }]} numberOfLines={1}>
          {name}
        </Text>
        <Text style={[type.caption, { color: ink, opacity: 0.7 }]}>{[got === null ? "Couldn't be read" : fileSize(bytes), time].filter((s) => s !== undefined).join(" · ")}</Text>
      </View>
    </Pressable>
  );
}

/** A picture full screen, on black: pinch or double-tap to zoom, Share and Done over it in glass. */
export function ImageViewer({ image, onClose }: { image: AttachmentGetOutput | null; onClose: () => void }) {
  const screen = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [chrome, setChrome] = useState(true);
  if (image === null) return null;
  return (
    <Modal visible animationType="fade" presentationStyle="overFullScreen" transparent onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.viewer} accessibilityViewIsModal>
        <ScrollView
          maximumZoomScale={4}
          minimumZoomScale={1}
          centerContent
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.zoom}
        >
          <Pressable onPress={() => setChrome((c) => !c)} accessible={false}>
            <Image source={{ uri: uriOf(image) }} style={{ width: screen.width, height: screen.height }} resizeMode="contain" accessibilityLabel={image.name} />
          </Pressable>
        </ScrollView>
        {chrome ? (
          <View style={[styles.viewerBar, { top: insets.top + space.sm }]}>
            <Glass interactive style={styles.viewerButton}>
              <Pressable accessibilityRole="button" accessibilityLabel="Done" onPress={onClose} style={styles.viewerHit}>
                <Icon name="close" size={17} color="#FFFFFF" weight="semibold" />
              </Pressable>
            </Glass>
            <Text style={[type.headline, styles.viewerTitle]} numberOfLines={1}>
              {image.name}
            </Text>
            <Glass interactive style={styles.viewerButton}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Share"
                onPress={() => {
                  haptics.tap();
                  void shareFile(image).catch(() => undefined);
                }}
                style={styles.viewerHit}
              >
                <Icon name="share" size={18} color="#FFFFFF" weight="semibold" />
              </Pressable>
            </Glass>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  image: { borderRadius: 18, borderCurve: "continuous" },
  pressed: { opacity: 0.8 },
  imageTime: { position: "absolute", right: 8, bottom: 8, borderRadius: 9, paddingHorizontal: 6, paddingVertical: 2, backgroundColor: "rgba(0,0,0,0.45)" },
  imageTimeText: { color: "#FFFFFF", fontVariant: ["tabular-nums"] },
  missing: { flexDirection: "row", alignItems: "center", gap: space.sm, borderRadius: 18, paddingHorizontal: space.md, paddingVertical: space.md },
  file: { flexDirection: "row", alignItems: "center", gap: space.md, borderRadius: 18, borderCurve: "continuous", paddingVertical: 10, paddingLeft: 10, paddingRight: space.lg, maxWidth: 280 },
  fileIcon: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  fileText: { flexShrink: 1, gap: 1 },
  strong: { fontWeight: "600" },
  viewer: { flex: 1, backgroundColor: "#000000" },
  zoom: { flexGrow: 1, alignItems: "center", justifyContent: "center" },
  viewerBar: { position: "absolute", left: space.lg, right: space.lg, flexDirection: "row", alignItems: "center", gap: space.md },
  viewerButton: { width: 44, height: 44, borderRadius: 22 },
  viewerHit: { flex: 1, alignItems: "center", justifyContent: "center" },
  viewerTitle: { flex: 1, color: "#FFFFFF", textAlign: "center" },
});
