// The person's avatar as a picture for iOS's bar button (screens/Chats.tsx meItem): their photo cut round, else their
// initial on the neutral dome Avatar draws, the button's full size. A bar button shows an image, not a view, and it is
// the only kind iOS moves into the iPhone Duo's side strip: so the avatar is drawn once offscreen and read back as a PNG.
import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Circle, ClipPath, Defs, Image, LinearGradient, Stop, Text } from "react-native-svg";
import { NEUTRAL } from "./Avatar";

/** The button's size in points, as iOS 26's glass bar buttons beside it (+, the filters). */
export const ME_BUTTON = 48;
/** Drawn at 3x: the phones' scale, so it is sharp; the bar reads it at `scale` 3. */
const SCALE = 3;

export function MeImage({ initial, photo, dark, onImage }: { initial: string; photo: string | undefined; dark: boolean; onImage: (uri: string) => void }) {
  const ref = useRef<Svg>(null);
  // A photo is drawn once it has loaded, or the PNG would hold the letter alone.
  const [loaded, setLoaded] = useState<string | undefined>(undefined);
  const ready = photo === undefined || loaded === photo;
  const n = NEUTRAL[dark ? "dark" : "light"];
  const r = ME_BUTTON / 2;
  useEffect(() => {
    if (!ready) return;
    // After the frame that draws it.
    const timer = setTimeout(() => ref.current?.toDataURL((b64) => onImage(`data:image/png;base64,${b64}`), { width: ME_BUTTON * SCALE, height: ME_BUTTON * SCALE }), 0);
    return () => clearTimeout(timer);
  }, [initial, photo, dark, ready, onImage]);
  return (
    <View pointerEvents="none" style={styles.away} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      <Svg ref={ref} width={ME_BUTTON} height={ME_BUTTON}>
        <Defs>
          <LinearGradient id="dome" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={n.top} />
            <Stop offset="1" stopColor={n.bottom} />
          </LinearGradient>
          <ClipPath id="round">
            <Circle cx={r} cy={r} r={r} />
          </ClipPath>
        </Defs>
        <Circle cx={r} cy={r} r={r} fill="url(#dome)" />
        <Text x={r} y={r + ME_BUTTON * 0.42 * 0.36} textAnchor="middle" fontSize={ME_BUTTON * 0.42} fontWeight="500" fill={n.ink}>
          {initial}
        </Text>
        {photo === undefined ? null : (
          <Image href={{ uri: photo }} width={ME_BUTTON} height={ME_BUTTON} preserveAspectRatio="xMidYMid slice" clipPath="url(#round)" onLoad={() => setLoaded(photo)} />
        )}
        <Circle cx={r} cy={r} r={r - 0.5} fill="none" stroke={n.rim} strokeWidth={1} />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({ away: { position: "absolute", left: -1000, top: 0, width: ME_BUTTON, height: ME_BUTTON } });
