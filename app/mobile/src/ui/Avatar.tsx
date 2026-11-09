// A chat's or a person's avatar: its picture once one was given (project_avatar_set, person_avatar_set), in a circle as
// iOS draws a contact's, else for a project its bot (Being, in the state the project is in), which has no circle, else
// its initials in a circle on a soft top-to-bottom gradient of a color picked from its name, as chat apps draw a
// person's. A picture is read from the hub once (Session.picture) and kept in the cache folder by its id, so it shows
// at once on the next launch; one not seen before fades in over the bot, which then goes, so it never moves unseen.
import { File, Paths } from "expo-file-system";
import { LinearGradient } from "expo-linear-gradient";
import { useContext, useEffect, useRef, useState } from "react";
import { Animated, Image, StyleSheet, Text, View } from "react-native";
import { initials, tintIndex } from "../avatar";
import type { BotState } from "../desktop";
import { SessionContext } from "../hubContext";
import { useTheme } from "../theme";
import { Being } from "./Being";
import { useBot } from "./botState";

/** "#RRGGBB" mixed toward white by `amount` (0 to 1). */
const lighter = (hex: string, amount: number): string => {
  const n = Number.parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  return `rgb(${String(mix((n >> 16) & 255))},${String(mix((n >> 8) & 255))},${String(mix(n & 255))})`;
};

/** Whose picture: a project's summary has these, or a person (hub_info's me). */
export type Pictured =
  | { readonly machineId: string; readonly projectId: string; readonly avatar?: string | undefined }
  | { readonly personId: string; readonly avatar?: string | undefined };

const fileOf = (avatar: string): File => new File(Paths.cache, `avatar-${avatar}.jpg`);

/** The pictures on disk by id, once looked for. */
const onDisk = new Map<string, string>();

const kept = (avatar: string): string | undefined => {
  const known = onDisk.get(avatar);
  if (known !== undefined) return known;
  try {
    const file = fileOf(avatar);
    if (!file.exists) return undefined;
    onDisk.set(avatar, file.uri);
    return file.uri;
  } catch {
    return undefined;
  }
};

/** Writes a picture read from the hub to the cache folder, before its uri shows; its bytes inline when that fails. */
const keep = (avatar: string, dataB64: string): string => {
  try {
    const file = fileOf(avatar);
    file.writeSync(dataB64, { encoding: "base64" });
    onDisk.set(avatar, file.uri);
    return file.uri;
  } catch {
    return `data:image/jpeg;base64,${dataB64}`;
  }
};

/** The picture's uri for `of`, undefined while it has none or it is being read. */
export const usePicture = (of: Pictured | undefined): { uri: string | undefined; fresh: boolean } => {
  const session = useContext(SessionContext);
  const avatar = of?.avatar;
  const personId = of !== undefined && "personId" in of ? of.personId : undefined;
  const machineId = of !== undefined && "machineId" in of ? of.machineId : undefined;
  const projectId = of !== undefined && "projectId" in of ? of.projectId : undefined;
  const [read, setRead] = useState<{ avatar: string; uri: string } | undefined>(undefined);
  const cached = avatar === undefined ? undefined : kept(avatar);
  useEffect(() => {
    if (avatar === undefined || cached !== undefined || session === null) return;
    const whose = personId !== undefined ? { personId } : machineId !== undefined && projectId !== undefined ? { machineId, projectId } : undefined;
    if (whose === undefined) return;
    let live = true;
    void session.picture(whose, avatar).then((b64) => {
      if (b64 !== null && live) setRead({ avatar, uri: keep(avatar, b64) });
    });
    return () => {
      live = false;
    };
  }, [session, personId, machineId, projectId, avatar, cached]);
  if (cached !== undefined) return { uri: cached, fresh: false };
  return { uri: read !== undefined && read.avatar === avatar ? read.uri : undefined, fresh: true };
};

/**
 * A person's letters, quieter than a chat's: a soft grey dome lit from above with dark letters, or in dark a deep grey
 * with light ones, and a hairline rim so it holds its edge on a card of a near color.
 */
const NEUTRAL = {
  light: { top: "#F4F4F7", bottom: "#D9D9DF", ink: "#3C3C43", rim: "rgba(0,0,0,0.07)" },
  dark: { top: "#5C5C62", bottom: "#38383C", ink: "#F2F2F7", rim: "rgba(255,255,255,0.09)" },
} as const;

export function Avatar({
  name,
  size = 52,
  picture,
  bot,
  person = false,
}: {
  name: string;
  size?: number;
  picture?: Pictured | undefined;
  /** A project's bot in this state, over the one its project's state gives (botState.ts): shown under its picture, or
   * alone while it has none. */
  bot?: BotState | undefined;
  /** A person's: neutral letters (NEUTRAL) rather than a color from their name. */
  person?: boolean;
}) {
  const t = useTheme();
  const tint = t.tints[tintIndex(name, t.tints.length)] ?? t.accent;
  const text = initials(name);
  const shown = usePicture(picture);
  const box = { width: size, height: size, borderRadius: size / 2 };
  const project = picture !== undefined && "machineId" in picture ? `${picture.machineId}/${picture.projectId}` : undefined;
  const state = useBot(project);
  const drawn = bot ?? state;
  // The picture that has come in over the bot, which goes from under it.
  const [covers, setCovers] = useState<string | undefined>(undefined);
  if (drawn !== undefined) {
    const uri = shown.uri;
    return (
      <View accessible={false} style={{ width: size, height: size }}>
        {uri !== undefined && covers === uri ? null : <Being state={drawn} size={size} />}
        {uri === undefined ? null : (
          <View style={[StyleSheet.absoluteFill, styles.base, box]}>
            <Picture key={uri} uri={uri} fade={shown.fresh} onShown={() => setCovers(uri)} />
          </View>
        )}
      </View>
    );
  }
  const neutral = person ? NEUTRAL[t.dark ? "dark" : "light"] : undefined;
  return (
    <View accessible={false} style={[styles.base, box, { backgroundColor: neutral?.bottom ?? tint }]}>
      <LinearGradient colors={neutral === undefined ? [lighter(tint, 0.32), tint] : [neutral.top, neutral.bottom]} style={StyleSheet.absoluteFill} />
      {neutral === undefined ? null : <View pointerEvents="none" style={[StyleSheet.absoluteFill, box, { borderWidth: StyleSheet.hairlineWidth, borderColor: neutral.rim }]} />}
      <Text
        allowFontScaling={false}
        style={{ color: neutral?.ink ?? "#FFFFFF", fontSize: size * (text.length > 1 ? 0.36 : 0.42), fontWeight: neutral === undefined ? "600" : "500", letterSpacing: 0.2 }}
      >
        {text}
      </Text>
      {shown.uri === undefined ? null : <Picture key={shown.uri} uri={shown.uri} fade={shown.fresh} />}
    </View>
  );
}

/** The picture over the letters or the bot: at once when it was on disk, else faded in as it loads; `onShown` once it
 * covers them. */
function Picture({ uri, fade, onShown }: { uri: string; fade: boolean; onShown?: () => void }) {
  const opacity = useRef(new Animated.Value(fade ? 0 : 1)).current;
  return (
    <Animated.View style={[StyleSheet.absoluteFill, { opacity }]}>
      <Image
        source={{ uri }}
        style={StyleSheet.absoluteFill}
        resizeMode="cover"
        fadeDuration={0}
        accessibilityIgnoresInvertColors
        onLoad={() => {
          if (!fade) return onShown?.();
          Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }).start(({ finished }) => {
            if (finished) onShown?.();
          });
        }}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: "center", justifyContent: "center", overflow: "hidden" },
});
