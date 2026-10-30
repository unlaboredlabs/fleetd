// A chat's avatar, a circle as iOS draws a contact's: its picture once a person gave it one (project_avatar_set), else
// its initials on a color picked from its name. A Navi's letters sit on a soft top-to-bottom gradient of its color, as
// Telegram draws a person's; a project's on a soft wash of it. A picture is read from the hub once (Session.picture)
// and kept in the cache folder by its id, so it shows at once on the next launch; one not seen before fades in over
// the letters.
import { File, Paths } from "expo-file-system";
import { LinearGradient } from "expo-linear-gradient";
import { useContext, useEffect, useRef, useState } from "react";
import { Animated, Image, StyleSheet, Text, View } from "react-native";
import { initials, tintIndex } from "../avatar";
import { SessionContext } from "../hubContext";
import { useTheme } from "../theme";

/** "#RRGGBB" mixed toward white by `amount` (0 to 1). */
export const lighter = (hex: string, amount: number): string => {
  const n = Number.parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  return `rgb(${String(mix((n >> 16) & 255))},${String(mix((n >> 8) & 255))},${String(mix(n & 255))})`;
};

/** "#RRGGBB" at an opacity. */
export const withAlpha = (hex: string, alpha: number): string => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${String((n >> 16) & 255)},${String((n >> 8) & 255)},${String(n & 255)},${String(alpha)})`;
};

/** Whose picture: a project's summary has these. */
export interface Pictured {
  readonly machineId: string;
  readonly projectId: string;
  readonly avatar?: string | undefined;
}

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

/** Writes a picture read from the hub to the cache folder; its bytes inline when that fails. */
const keep = (avatar: string, dataB64: string): string => {
  try {
    const file = fileOf(avatar);
    file.write(dataB64, { encoding: "base64" });
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
  const machineId = of?.machineId;
  const projectId = of?.projectId;
  const [read, setRead] = useState<{ avatar: string; uri: string } | undefined>(undefined);
  const cached = avatar === undefined ? undefined : kept(avatar);
  useEffect(() => {
    if (avatar === undefined || cached !== undefined || session === null || machineId === undefined || projectId === undefined) return;
    let live = true;
    void session.picture({ machineId, projectId }, avatar).then((b64) => {
      if (b64 !== null && live) setRead({ avatar, uri: keep(avatar, b64) });
    });
    return () => {
      live = false;
    };
  }, [session, machineId, projectId, avatar, cached]);
  if (cached !== undefined) return { uri: cached, fresh: false };
  return { uri: read !== undefined && read.avatar === avatar ? read.uri : undefined, fresh: true };
};

export function Avatar({ name, navi, size = 52, picture }: { name: string; navi: boolean; size?: number; picture?: Pictured | undefined }) {
  const t = useTheme();
  const tint = t.tints[tintIndex(name, t.tints.length)] ?? t.accent;
  const text = initials(name);
  const shown = usePicture(picture);
  const box = { width: size, height: size, borderRadius: size / 2 };
  return (
    <View accessible={false} style={[styles.base, box, { backgroundColor: navi ? tint : withAlpha(tint, t.dark ? 0.28 : 0.16) }]}>
      {navi ? <LinearGradient colors={[lighter(tint, 0.32), tint]} style={StyleSheet.absoluteFill} /> : null}
      <Text
        allowFontScaling={false}
        style={{ color: navi ? "#FFFFFF" : tint, fontSize: size * (text.length > 1 ? 0.36 : 0.42), fontWeight: "600", letterSpacing: 0.2 }}
      >
        {text}
      </Text>
      {shown.uri === undefined ? null : <Picture key={shown.uri} uri={shown.uri} fade={shown.fresh} />}
    </View>
  );
}

/** The picture over the letters: at once when it was on disk, else faded in as it loads. */
function Picture({ uri, fade }: { uri: string; fade: boolean }) {
  const opacity = useRef(new Animated.Value(fade ? 0 : 1)).current;
  return (
    <Animated.View style={[StyleSheet.absoluteFill, { opacity }]}>
      <Image
        source={{ uri }}
        style={StyleSheet.absoluteFill}
        resizeMode="cover"
        fadeDuration={0}
        onLoad={() => {
          if (fade) Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }).start();
        }}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: "center", justifyContent: "center", overflow: "hidden" },
});
