// What a message carries besides words: a picture, shown as itself with rounded corners as Messages does, which opens
// full screen to pinch, zoom and share; and any other file, as a card with its kind, name and size that opens the
// share sheet (Save to Files, another app). A picture's bubble reads its preview (session.preview, kept on disk), the
// viewer the picture itself; a file is read only when it is opened, in pieces that resume after a drop.
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Image, Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { bubble, bubbleMax, photoSize } from "../bubble";
import { fileSize } from "../chatView";
import { glyphOf, kindOf, type AttachmentGetOutput, type FileGlyph, type HubError } from "../desktop";
import { useSession } from "../hubContext";
import type { Typed } from "../hub/client";
import { shareFile } from "../shareFile";
import type { Key } from "../store";
import { space, type, useTheme, type Palette } from "../theme";
import { Glass } from "./Glass";
import { haptics } from "./haptics";
import { Tail, TAIL_REACH } from "./Bubble";
import { Icon, type IconName } from "./Icon";
import { SkeletonBlock } from "./Skeleton";

/**
 * A picture's preview for its bubble, read from the hub or the disk: undefined while it comes, else the preview or why
 * it couldn't be had. One that couldn't is read again on `retry` (a tap) and each time the link is live again, never
 * kept as it failed.
 */
const usePreview = (chatKey: Key, attachmentId: string): { got: Typed<"attachment_get"> | undefined; retry: () => void } => {
  const session = useSession();
  const [got, setGot] = useState<Typed<"attachment_get"> | undefined>(undefined);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    let on = true;
    setGot(undefined);
    void session.preview(chatKey, attachmentId).then((out) => {
      if (on) setGot(out);
    });
    return () => {
      on = false;
    };
  }, [session, chatKey, attachmentId, tries]);
  const failed = got?.ok === false;
  const retry = useCallback(() => setTries((n) => n + 1), []);
  useEffect(() => (failed ? session.onLive(retry) : undefined), [session, failed, retry]);
  return { got, retry };
};

/** A picture opened full screen: the one its bubble showed, until the picture itself is read. */
export type OpenedImage = { readonly chatKey: Key; readonly attachmentId: string; readonly shown: AttachmentGetOutput };

const uriOf = (a: AttachmentGetOutput): string => `data:${a.mime};base64,${a.dataB64}`;

/**
 * A picture in the thread, sized as Messages sizes one (../bubble.ts): its own shape, a soft block while it loads. The
 * last of a burst has the tail, cut from the picture. Every picture is drawn TAIL_REACH taller than its box, tail or
 * not, so it keeps its scale when it lifts into the menu without one.
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
  onOpen: (a: OpenedImage) => void;
  side: "me" | "them";
  tail?: boolean;
}) {
  const t = useTheme();
  const screen = useWindowDimensions();
  const { got: read, retry } = usePreview(chatKey, attachmentId);
  const got = read?.ok === true ? read.output : undefined;
  const [aspect, setAspect] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (got === undefined) return;
    Image.getSize(uriOf(got), (w, h) => setAspect(w / h), () => setAspect(4 / 3));
  }, [got]);
  if (read?.ok === false)
    // Why the hub couldn't give it, and a tap reads it again.
    return (
      <Pressable accessibilityRole="button" accessibilityHint="Reads it again" onPress={retry} style={({ pressed }) => [styles.missing, { backgroundColor: t.fillQuiet }, pressed && styles.pressed]}>
        <Icon name="photos" size={18} color={t.secondary} />
        <Text style={[type.footnote, styles.missingText, { color: t.secondary }]}>
          {`${name} couldn't be read. ${read.error.message} `}
          <Text style={{ color: t.accent }}>Try Again</Text>
        </Text>
      </Pressable>
    );
  const { width, height } = photoSize(screen.width, aspect ?? 4 / 3);
  if (got === undefined || aspect === undefined) return <SkeletonBlock width={width} height={height} radius={bubble.radius} />;
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={`Photo, ${name}`}
      accessibilityHint="Opens it full screen"
      onPress={() => onOpen({ chatKey, attachmentId, shown: got })}
    >
      {({ pressed }) => {
        const picture = <Image source={{ uri: uriOf(got) }} style={{ width, height: height + TAIL_REACH }} resizeMode="cover" accessibilityIgnoresInvertColors />;
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

/** Each kind's glyph, and the system color its tile takes: red for a PDF, green for a sheet, as Files tints them. */
export const GLYPHS: Readonly<Record<FileGlyph, { readonly icon: IconName; readonly tint: (t: Palette) => string }>> = {
  pdf: { icon: "pdf", tint: (t) => t.danger },
  doc: { icon: "fileDoc", tint: (t) => t.blue },
  sheet: { icon: "fileSheet", tint: (t) => t.success },
  slides: { icon: "fileSlides", tint: (t) => t.orange },
  zip: { icon: "fileZip", tint: (t) => t.indigo },
  text: { icon: "fileText", tint: (t) => t.muted },
  image: { icon: "fileImage", tint: (t) => t.blue },
  file: { icon: "file", tint: (t) => t.muted },
};

/**
 * Any other file: its kind's glyph on a tile of its color, its name, and its kind and size. Tapping reads it from the
 * hub and opens the share sheet with the file as itself, its preview on top: Save to Files, or open it in Numbers,
 * Pages or another app. Nothing is read before the tap: a card costs no bytes.
 */
export function FileBubble({ chatKey, attachmentId, name, mime, bytes, mine, tail = false }: { chatKey: Key; attachmentId: string; name: string; mime: string; bytes: number; mine: boolean; tail?: boolean }) {
  const t = useTheme();
  const session = useSession();
  // undefined: not read yet, or shared; "reading"; or why the hub couldn't give it (a tap reads it again).
  const [got, setGot] = useState<"reading" | HubError | undefined>(undefined);
  const failed = typeof got === "object" ? got : undefined;
  const screen = useWindowDimensions();
  const ink = mine ? t.onAccentDeep : t.label;
  const fill = mine ? t.accentDeep : t.bubble;
  const glyph = GLYPHS[glyphOf(mime)];
  const meta = failed !== undefined ? `Couldn't be read: ${failed.message} Tap to try again.` : bytes > 0 ? `${kindOf(mime)} · ${fileSize(bytes)}` : kindOf(mime);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${kindOf(mime)}, ${name}${bytes > 0 ? `, ${fileSize(bytes)}` : ""}`}
      accessibilityHint={failed !== undefined ? "Reads it again" : "Opens the share sheet to save it or open it in another app"}
      disabled={got === "reading"}
      onPress={() => {
        haptics.tap();
        setGot("reading");
        void session.attachment(chatKey, attachmentId).then((read) => {
          setGot(read.ok ? undefined : read.error);
          if (read.ok) void shareFile(read.output).catch(() => undefined);
        });
      }}
      style={({ pressed }) => [styles.file, { backgroundColor: fill, width: Math.min(bubbleMax(screen.width), FILE_WIDTH) }, pressed && styles.pressed]}
    >
      {tail ? <Tail side={mine ? "me" : "them"} fill={fill} /> : null}
      <View style={[styles.fileIcon, { backgroundColor: mine ? "rgba(255,255,255,0.22)" : glyph.tint(t) }]}>
        <Icon name={glyph.icon} size={20} color="#FFFFFF" />
      </View>
      <View style={styles.fileText}>
        <Text style={[type.subhead, styles.strong, { color: ink }]} numberOfLines={1} ellipsizeMode="middle">
          {name}
        </Text>
        <Text style={[type.caption, { color: ink, opacity: 0.7 }]} numberOfLines={failed !== undefined ? 3 : 1}>
          {meta}
        </Text>
      </View>
      {got === "reading" ? <ActivityIndicator size="small" color={ink} /> : <Icon name="share" size={17} color={mine ? ink : t.accent} weight="medium" />}
    </Pressable>
  );
}

/** A file card's width: one size for every file, as Messages draws them, within the bubble's widest. */
const FILE_WIDTH = 288;

/**
 * A picture full screen, on black: pinch or double-tap to zoom, Share and Done over it in glass. It opens on the
 * bubble's preview and turns sharp once the picture itself is read; Share sends the picture itself.
 */
export function ImageViewer({ image: opened, onClose }: { image: OpenedImage | null; onClose: () => void }) {
  const screen = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const session = useSession();
  const [chrome, setChrome] = useState(true);
  const [full, setFull] = useState<AttachmentGetOutput | null>(null);
  useEffect(() => {
    setFull(null);
    if (opened === null) return;
    if (opened.shown.preview !== true) return setFull(opened.shown);
    let on = true;
    void session.attachment(opened.chatKey, opened.attachmentId).then((read) => {
      if (on && read.ok) setFull(read.output);
    });
    return () => {
      on = false;
    };
  }, [session, opened]);
  if (opened === null) return null;
  const image = full ?? opened.shown;
  return (
    <Modal visible animationType="fade" presentationStyle="overFullScreen" transparent onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.viewer} accessibilityViewIsModal onAccessibilityEscape={onClose}>
        <ScrollView
          maximumZoomScale={4}
          minimumZoomScale={1}
          centerContent
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.zoom}
        >
          <Pressable onPress={() => setChrome((c) => !c)} accessible={false}>
            <Image source={{ uri: uriOf(image) }} style={{ width: screen.width, height: screen.height }} resizeMode="contain" accessibilityLabel={image.name} accessibilityIgnoresInvertColors />
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
                  void session
                    .attachment(opened.chatKey, opened.attachmentId)
                    .then((read) => (read.ok ? shareFile(read.output) : undefined))
                    .catch(() => undefined);
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
  missingText: { flexShrink: 1 },
  missing: { flexDirection: "row", alignItems: "center", gap: space.sm, borderRadius: bubble.radius, borderCurve: "continuous", paddingHorizontal: bubble.padX, paddingVertical: bubble.padY },
  file: { flexDirection: "row", alignItems: "center", gap: space.md, borderRadius: bubble.radius, borderCurve: "continuous", paddingVertical: 10, paddingLeft: 10, paddingRight: bubble.padX },
  fileIcon: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  fileText: { flex: 1, gap: 1 },
  strong: { fontWeight: "600" },
  viewer: { flex: 1, backgroundColor: "#000000" },
  zoom: { flexGrow: 1, alignItems: "center", justifyContent: "center" },
  viewerBar: { position: "absolute", left: space.lg, right: space.lg, flexDirection: "row", alignItems: "center", gap: space.md },
  viewerButton: { width: 44, height: 44, borderRadius: 22 },
  viewerHit: { flex: 1, alignItems: "center", justifyContent: "center" },
  viewerTitle: { flex: 1, color: "#FFFFFF", textAlign: "center" },
});
