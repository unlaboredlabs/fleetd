// What a message carries besides words: a picture, shown as itself with rounded corners as Messages does, which opens
// full screen to pinch, zoom and share; and any other file, as a card with its name and size that opens the share
// sheet (Save to Files, another app). Each is read from the hub once (attachment_get) as its bubble shows.
import { File, Paths } from "expo-file-system";
import { useEffect, useState } from "react";
import { Image, Modal, Pressable, ScrollView, Share, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { bubble, bubbleMax, photoSize } from "../bubble";
import { fileSize } from "../chatView";
import type { AttachmentGetOutput } from "../desktop";
import { useSession } from "../hubContext";
import type { Key } from "../store";
import { space, type, useTheme } from "../theme";
import { Glass } from "./Glass";
import { haptics } from "./haptics";
import { Tail, TAIL_REACH } from "./Bubble";
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

/**
 * A picture in the thread, sized as Messages sizes one (../bubble.ts): its own shape, a soft block while it loads. The
 * last of a burst has the tail, cut from the picture: it's drawn TAIL_REACH taller, its box keeps the rest of it.
 */
export function ImageBubble({
  chatKey,
  attachmentId,
  name,
  onOpen,
  side,
  tail = false,
}: {
  chatKey: Key;
  attachmentId: string;
  name: string;
  onOpen: (a: AttachmentGetOutput) => void;
  side: "me" | "them";
  tail?: boolean;
}) {
  const t = useTheme();
  const screen = useWindowDimensions();
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
  const { width, height } = photoSize(screen.width, aspect ?? 4 / 3);
  if (got === undefined || aspect === undefined) return <SkeletonBlock width={width} height={height} radius={bubble.radius} />;
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={`Photo, ${name}`}
      accessibilityHint="Opens it full screen"
      onPress={() => onOpen(got)}
    >
      {({ pressed }) => {
        const picture = <Image source={{ uri: uriOf(got) }} style={{ width, height: tail ? height + TAIL_REACH : height }} resizeMode="cover" />;
        return (
          <View style={pressed && styles.pressed}>
            <View style={[styles.image, { width, height, backgroundColor: t.fillQuiet }]}>{picture}</View>
            {tail ? <Tail side={side} picture={{ node: picture, size: { width, height } }} /> : null}
          </View>
        );
      }}
    </Pressable>
  );
}

/** Any other file: its kind, name and size; tapping shares it (Save to Files, Quick Look in another app). */
export function FileBubble({ chatKey, attachmentId, name, mime, bytes, mine, tail = false }: { chatKey: Key; attachmentId: string; name: string; mime: string; bytes: number; mine: boolean; tail?: boolean }) {
  const t = useTheme();
  const got = useAttachment(chatKey, attachmentId);
  const screen = useWindowDimensions();
  const ink = mine ? t.onAccent : t.label;
  const fill = mine ? t.accentFill : t.bubble;
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
      style={({ pressed }) => [styles.file, { backgroundColor: fill, maxWidth: bubbleMax(screen.width) }, pressed && styles.pressed]}
    >
      {tail ? <Tail side={mine ? "me" : "them"} fill={fill} /> : null}
      <View style={[styles.fileIcon, { backgroundColor: mine ? "rgba(255,255,255,0.22)" : t.accentFill }]}>
        <Icon name={mime === "application/pdf" ? "pdf" : "file"} size={18} color="#FFFFFF" />
      </View>
      <View style={styles.fileText}>
        <Text style={[type.subhead, styles.strong, { color: ink }]} numberOfLines={1}>
          {name}
        </Text>
        <Text style={[type.caption, { color: ink, opacity: 0.7 }]}>{got === null ? "Couldn't be read" : fileSize(bytes)}</Text>
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
  image: { borderRadius: bubble.radius, borderCurve: "continuous", overflow: "hidden" },
  pressed: { opacity: 0.8 },
  // A bubble's corners, side padding and widest (FileBubble); a file's icon sits 10 in.
  missing: { flexDirection: "row", alignItems: "center", gap: space.sm, borderRadius: bubble.radius, borderCurve: "continuous", paddingHorizontal: bubble.padX, paddingVertical: bubble.padY },
  file: { flexDirection: "row", alignItems: "center", gap: space.md, borderRadius: bubble.radius, borderCurve: "continuous", paddingVertical: 10, paddingLeft: 10, paddingRight: bubble.padX },
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
