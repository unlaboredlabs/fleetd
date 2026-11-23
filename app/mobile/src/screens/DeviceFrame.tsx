// A phone screen's device on the phone (W859), the desktop's DeviceStage in native views: the device the simulator is
// (deviceModel: an iPhone Duo's cover, its inner display, an iPhone with its island, a plain phone), its picture
// filling the display exactly, the frame's bezel and corners the device's own. In 3D it stands with depth: its sides
// drawn as layers behind its face, a drag turning it (it springs back to face you), and a Duo half open stands as a
// book, or a laptop on its side, its halves turned about the hinge. All of it is transforms the UI thread plays
// (Reanimated), so turning it costs the JS thread nothing. Flat, it is the same device face on.
import { useEffect, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, type SharedValue } from "react-native-reanimated";
import { flatOf, type Body, type Pose } from "../desktop";

/** How far away the eye is, in points: a phone held at arm's length. */
const PERSPECTIVE = 900;
/** The frame's metal edge, in points, inside its bezel. */
const EDGE = 1.5;
/** Layers that draw a side's depth: enough that turning it shows a solid edge. */
const LAYERS = 8;

const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;
/** The metal's colour, darker by `k` (0 to 1), for the sides away from the light. */
const shade = (n: number, k: number) => {
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * (1 - k)));
  return `rgb(${c.join(",")})`;
};

export function DeviceFrame({
  body,
  pose,
  size,
  three,
  folds,
  yaw,
  pitch,
  screen,
}: {
  body: Body;
  pose: Pose;
  /** The device's whole size here, bezel and all, in points. */
  size: { width: number; height: number };
  /** In 3D: depth, a drag's turn, a Duo's fold. */
  three: boolean;
  /**
   * A half-open Duo may stand folded: only while you watch. While it's yours it shows face on, flat, so a touch lands
   * on the picture where the page maps it (screen.ts toFrame).
   */
  folds: boolean;
  /** The drag's turn, degrees (the screen springs them back to 0). */
  yaw: SharedValue<number>;
  pitch: SharedValue<number>;
  /** The display's content: the picture, at the display's size. */
  screen: ReactNode;
}) {
  const f = flatOf(body, pose);
  const W = size.width;
  const H = size.height;
  const b = f.bezelX * W;
  const outer = f.outer.map((r) => r * W);
  const inner = f.inner.map((r) => r * W);
  const corners = (r: readonly number[]) => ({ borderTopLeftRadius: r[0], borderTopRightRadius: r[1], borderBottomRightRadius: r[2], borderBottomLeftRadius: r[3] });
  // Its depth on screen, at this scale.
  const depth = f.depth * W;
  const fold = three && folds && body.kind === "duo" && pose.panel === "inner" && pose.hinge < 180 ? (180 - pose.hinge) / 2 : 0;

  const face = useAnimatedStyle(() => ({ transform: [{ perspective: PERSPECTIVE }, { rotateY: `${String(yaw.value)}deg` }, { rotateX: `${String(pitch.value)}deg` }] }));
  // The metal's edge is part of the bezel: the display is the picture's size exactly, as the page's touches take it.
  const frameStyle = [styles.frame, corners(outer), { width: W, height: H, padding: Math.max(0, b - EDGE), borderColor: hex(body.finish.frame) }];
  const island =
    f.island === undefined ? null : (
      <View
        pointerEvents="none"
        style={[
          styles.island,
          {
            // Placed inside the metal edge, as the display is.
            left: b - EDGE + (W - 2 * b) * f.island.left,
            top: b - EDGE + (H - 2 * b) * f.island.top,
            width: (W - 2 * b) * f.island.width,
            height: (H - 2 * b) * f.island.height,
          },
        ]}
      />
    );
  const display = (
    <View style={[styles.display, corners(inner)]}>
      {screen}
      {f.crease === undefined ? null : <View pointerEvents="none" style={f.crease === "down" ? styles.creaseDown : styles.creaseAcross} />}
    </View>
  );

  // A Duo's inner display in 3D is always its two halves: opening and folding move them, never swap one view for another.
  if (three && body.kind === "duo" && pose.panel === "inner") {
    return <Halves W={W} H={H} b={b} outer={outer} inner={inner} across={f.crease === "across"} turn={fold} finish={body.finish.frame} yaw={yaw} pitch={pitch} screen={screen} />;
  }

  return (
    <View style={{ width: W, height: H }}>
      {three
        ? Array.from({ length: LAYERS }, (_, i) => LAYERS - i).map((i) => (
            <Layer key={i} i={i} depth={depth} yaw={yaw} pitch={pitch} style={[StyleSheet.absoluteFill, corners(outer), { backgroundColor: shade(body.finish.frame, 0.15 + (0.35 * i) / LAYERS) }]} />
          ))
        : null}
      <Animated.View style={[frameStyle, three ? face : null]}>
        {display}
        {island}
      </Animated.View>
    </View>
  );
}

/** One layer of a side, `i` of LAYERS deep: where its face would be once turned, behind the face. */
function Layer({ i, depth, yaw, pitch, style }: { i: number; depth: number; yaw: SharedValue<number>; pitch: SharedValue<number>; style: object }) {
  const moved = useAnimatedStyle(() => {
    const d = (depth * i) / LAYERS;
    const y = (yaw.value * Math.PI) / 180;
    const p = (pitch.value * Math.PI) / 180;
    return {
      transform: [
        { perspective: PERSPECTIVE },
        { translateX: -d * Math.sin(y) },
        { translateY: d * Math.sin(p) },
        { rotateY: `${String(yaw.value)}deg` },
        { rotateX: `${String(pitch.value)}deg` },
      ],
    };
  });
  return <Animated.View style={[style, moved]} />;
}

/**
 * A Duo's inner display: its two halves on the hinge, each showing its half of the picture, turned `turn` degrees each
 * toward you (0 flat open, 25 half open) as a book (the crease down) or a laptop (the crease across, lying back). The
 * turn and the framing that keeps it within its room follow on a spring, so opening and folding move rather than jump,
 * and a flat inner display is the same views as a folded one: nothing is made anew when it folds.
 */
function Halves({
  W,
  H,
  b,
  outer,
  inner,
  across,
  turn,
  finish,
  yaw,
  pitch,
  screen,
}: {
  W: number;
  H: number;
  b: number;
  outer: number[];
  inner: number[];
  across: boolean;
  turn: number;
  finish: number;
  yaw: SharedValue<number>;
  pitch: SharedValue<number>;
  screen: ReactNode;
}) {
  const turnV = useSharedValue(turn);
  useEffect(() => {
    turnV.value = withSpring(turn, FOLD_SPRING);
  }, [turnV, turn]);
  // Folded, its near edges come toward you: it stands a little smaller to keep within its room, and a laptop, leaning
  // back about its hinge, a little lower; flat, it is the whole room's.
  const framed = useAnimatedStyle(() => {
    const k = Math.min(1, turnV.value / HALF_TURN);
    return { transform: across ? [{ translateY: H * 0.14 * k }, { scale: 1 - 0.1 * k }] : [{ scale: 1 - 0.16 * k }] };
  });
  const r = (i: number) => outer[i] ?? 0;
  const ir = (i: number) => inner[i] ?? 0;
  return (
    <Animated.View style={[{ width: W, height: H, flexDirection: across ? "column" : "row" }, framed]}>
      <Leaf first across={across} W={W} H={H} b={b} r={across ? [r(0), r(1), 0, 0] : [r(0), 0, 0, r(3)]} ir={across ? [ir(0), ir(1), 0, 0] : [ir(0), 0, 0, ir(3)]} turnV={turnV} finish={finish} yaw={yaw} pitch={pitch} screen={screen} />
      <Leaf first={false} across={across} W={W} H={H} b={b} r={across ? [0, 0, r(2), r(3)] : [0, r(1), r(2), 0]} ir={across ? [0, 0, ir(2), ir(3)] : [0, ir(1), ir(2), 0]} turnV={turnV} finish={finish} yaw={yaw} pitch={pitch} screen={screen} />
    </Animated.View>
  );
}

/** One half: turned about its hinge edge, then the whole device turned about its middle (the hinge), as a drag says. */
function Leaf({
  first,
  across,
  W,
  H,
  b,
  r,
  ir,
  turnV,
  finish,
  yaw,
  pitch,
  screen,
}: {
  first: boolean;
  across: boolean;
  W: number;
  H: number;
  b: number;
  r: number[];
  ir: number[];
  turnV: SharedValue<number>;
  finish: number;
  yaw: SharedValue<number>;
  pitch: SharedValue<number>;
  screen: ReactNode;
}) {
  const w = across ? W : W / 2;
  const h = across ? H / 2 : H;
  // From the half's middle to the hinge.
  const toHinge = (across ? h : w) / 2;
  const sign = first ? 1 : -1;
  const turned = useAnimatedStyle(() => {
    const k = Math.min(1, turnV.value / HALF_TURN);
    return {
      transform: across
        ? [
            { perspective: PERSPECTIVE },
            { translateY: sign * toHinge },
            { rotateY: `${String(yaw.value)}deg` },
            // A laptop leans back as it folds, its lower half nearly flat.
            { rotateX: `${String(pitch.value + 40 * k)}deg` },
            { rotateX: `${String(-sign * turnV.value)}deg` },
            { translateY: -sign * toHinge },
          ]
        : [
            { perspective: PERSPECTIVE },
            { translateX: sign * toHinge },
            { rotateY: `${String(yaw.value)}deg` },
            { rotateX: `${String(pitch.value)}deg` },
            { rotateY: `${String(sign * turnV.value)}deg` },
            { translateX: -sign * toHinge },
          ],
    };
  });
  const corners = (c: number[]) => ({ borderTopLeftRadius: c[0], borderTopRightRadius: c[1], borderBottomRightRadius: c[2], borderBottomLeftRadius: c[3] });
  // The metal edge and the bezel on the outer sides only: at the hinge the two halves' displays meet, so laid flat
  // they are one display, the picture's size, as the page's touches take it.
  const pad = Math.max(0, b - EDGE);
  const sides = across
    ? first
      ? { paddingTop: pad, paddingHorizontal: pad, borderTopWidth: EDGE, borderLeftWidth: EDGE, borderRightWidth: EDGE, borderBottomWidth: 0 }
      : { paddingBottom: pad, paddingHorizontal: pad, borderBottomWidth: EDGE, borderLeftWidth: EDGE, borderRightWidth: EDGE, borderTopWidth: 0 }
    : first
      ? { paddingLeft: pad, paddingVertical: pad, borderLeftWidth: EDGE, borderTopWidth: EDGE, borderBottomWidth: EDGE, borderRightWidth: 0 }
      : { paddingRight: pad, paddingVertical: pad, borderRightWidth: EDGE, borderTopWidth: EDGE, borderBottomWidth: EDGE, borderLeftWidth: 0 };
  // The half's share of the display: the whole display, moved so this half's part shows.
  const showW = W - 2 * b;
  const showH = H - 2 * b;
  return (
    <Animated.View style={[styles.leaf, corners(r), { width: w, height: h, borderColor: hex(finish) }, sides, turned]}>
      <View style={[styles.display, corners(ir)]}>
        <View style={{ position: "absolute", width: showW, height: showH, left: across || first ? 0 : -(showW / 2), top: !across || first ? 0 : -(showH / 2) }}>{screen}</View>
      </View>
    </Animated.View>
  );
}

/** A Duo half open's turn of each half, degrees: (180 − 130) / 2. */
const HALF_TURN = 25;
/** How a fold settles: unhurried, no bounce (a hinge doesn't overshoot). */
const FOLD_SPRING = { damping: 30, stiffness: 180, mass: 1 } as const;

const styles = StyleSheet.create({
  frame: { backgroundColor: "#0c0c0d", borderWidth: EDGE, overflow: "hidden", borderCurve: "continuous" },
  leaf: { backgroundColor: "#0c0c0d", overflow: "hidden", borderCurve: "continuous" },
  display: { flex: 1, overflow: "hidden", backgroundColor: "#000000", borderCurve: "continuous" },
  island: { position: "absolute", borderRadius: 999, backgroundColor: "#000000" },
  creaseDown: { position: "absolute", top: 0, bottom: 0, left: "50%", width: StyleSheet.hairlineWidth, backgroundColor: "#00000033" },
  creaseAcross: { position: "absolute", left: 0, right: 0, top: "50%", height: StyleSheet.hairlineWidth, backgroundColor: "#00000033" },
});
