// A bubble's markdown (markdown.ts) as native text: code in monospace, links that open in the browser, lists with
// hanging bullets, tables that wrap their cells or scroll sideways. `ink` is the bubble's text color; on the accent,
// links are underlined in it rather than drawn in the link's blue. A bubble's words aren't selectable where they
// stand, as in Messages: holding one opens its menu, whose Select Text has them.
import * as Clipboard from "expo-clipboard";
import { LinearGradient } from "expo-linear-gradient";
import { createContext, Fragment, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Linking, PixelRatio, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View, type TextLayoutEvent, type TextStyle } from "react-native";
import { fenceView, parseMarkdown, UNSHOWN, type Block, type Inline } from "../markdown";
import { bubble, fitWidth } from "../bubble";
import { columnWidths, isNumeric, longestWord, type Measured } from "../table";
import { mono, space, type, useTheme } from "../theme";
import { haptics } from "./haptics";
import { Icon } from "./Icon";
import { SkeletonBlock } from "./Skeleton";

/**
 * `fit`: the words take only as wide as their longest line, as Messages' bubbles do, where a Text takes all the width it
 * may. Paragraphs and headings measure their lines once for each text and text size, then draw at that width; other
 * blocks (a list, code) keep the whole width. Off while the text still streams in, so the bubble doesn't narrow and
 * widen with each word. Turning it on, or a new text size, lays the words out afresh at the whole width to measure them.
 * `ground`: the color under the words when they aren't in a bubble, for a wide table's edge fade. In a bubble (none
 * given), the fade is the bubble's fill, and a table scrolls out to the bubble's edges.
 * `holdsBlocks` (on unless a person wrote the words): a fleetd-block fence that reaches here didn't show (`fenceView`),
 * so it never draws as its JSON; a person's own fence is code they wrote.
 */
export function Markdown({ text, ink, onAccent = false, fit = false, streaming = false, holdsBlocks = true, ground }: { text: string; ink: string; onAccent?: boolean; fit?: boolean; streaming?: boolean; holdsBlocks?: boolean; ground?: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const fits = fit && blocks.every((b) => b.t === "p" || b.t === "h");
  const { fontScale } = useWindowDimensions();
  const key = `${String(fontScale)}:${text}`;
  const lines = useRef<{ key: string; widths: number[] }>({ key: "", widths: [] });
  const [fitted, setFitted] = useState<{ key: string; width: number } | undefined>(undefined);
  const measure = (i: number) => (e: TextLayoutEvent) => {
    if (fitted?.key === key) return;
    if (lines.current.key !== key) lines.current = { key, widths: [] };
    const widths = lines.current.widths;
    widths[i] = Math.max(0, ...e.nativeEvent.lines.map((l) => l.width));
    if (blocks.every((_, k) => widths[k] !== undefined)) setFitted({ key, width: fitWidth(widths, PixelRatio.get()) });
  };
  const width = fits && fitted?.key === key ? fitted.width : undefined;
  return (
    // A new key mounts the words again, so they lay out and report their lines: a change to onTextLayout alone doesn't.
    <View key={fits ? `fit:${String(fontScale)}` : "whole"} style={[styles.blocks, width !== undefined && { width }]}>
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} ink={ink} onAccent={onAccent} streaming={streaming} holdsBlocks={holdsBlocks} ground={ground} onLines={fits ? measure(i) : undefined} />
      ))}
    </View>
  );
}

function BlockView({ block, ink, onAccent, streaming = false, holdsBlocks = true, ground, onLines }: { block: Block; ink: string; onAccent: boolean; streaming?: boolean; holdsBlocks?: boolean; ground?: string | undefined; onLines?: ((e: TextLayoutEvent) => void) | undefined }) {
  const t = useTheme();
  const codeFill = onAccent ? "rgba(255,255,255,0.18)" : t.fillQuiet;
  // Messages' body type (../bubble.ts). No letter spacing of our own: iOS tracks the system font itself, as Messages' does.
  const base: TextStyle = { fontSize: bubble.fontSize, lineHeight: bubble.lineHeight, color: ink };
  switch (block.t) {
    case "p":
      return (
        <Text style={base} onTextLayout={onLines}>
          <Inlines nodes={block.inline} ink={ink} onAccent={onAccent} />
        </Text>
      );
    case "h":
      return (
        <Text style={[base, block.level <= 2 ? type.title3 : type.headline, { color: ink }]} accessibilityRole="header" onTextLayout={onLines}>
          <Inlines nodes={block.inline} ink={ink} onAccent={onAccent} />
        </Text>
      );
    case "code":
      switch (fenceView(block, { streaming, blocks: holdsBlocks })) {
        case "pending":
          return <SkeletonBlock width={220} height={96} radius={12} />;
        case "unshown":
          return (
            <View style={styles.unshown} accessibilityRole="text" accessibilityLabel={UNSHOWN}>
              <Icon name="block" size={14} color={ink} />
              <Text style={[type.footnote, { color: ink }]}>{UNSHOWN}</Text>
            </View>
          );
        case "code":
          return <CodeBlock text={block.text} lang={block.lang} ink={ink} fill={codeFill} />;
      }
      break;
    case "quote":
      return (
        <View style={[styles.quote, { borderLeftColor: onAccent ? "rgba(255,255,255,0.5)" : t.tertiary }]}>
          {block.blocks.map((b, i) => (
            <BlockView key={i} block={b} ink={ink} onAccent={onAccent} streaming={streaming} holdsBlocks={holdsBlocks} ground={ground} />
          ))}
        </View>
      );
    case "list":
      return (
        <View style={styles.list}>
          {block.items.map((item, i) => (
            <View key={i} style={styles.item}>
              <Text style={[base, styles.marker]}>{block.ordered ? `${String(block.start + i)}.` : "•"}</Text>
              <Text style={[base, styles.itemText]}>
                <Inlines nodes={item} ink={ink} onAccent={onAccent} />
              </Text>
            </View>
          ))}
        </View>
      );
    case "hr":
      return <View style={[styles.rule, { backgroundColor: onAccent ? "rgba(255,255,255,0.4)" : t.separator }]} />;
    case "table":
      return <Grid header={block.header} rows={block.rows} ink={ink} onAccent={onAccent} rule={onAccent ? "rgba(255,255,255,0.3)" : t.separator} ground={ground ?? (onAccent ? t.accentFill : t.bubble)} bleed={ground === undefined ? bubble.padX : 0} settled={!streaming} />;
  }
}

/**
 * Fenced code: its language and a Copy button over it, and a tap anywhere on it copies it, as chat apps' code blocks.
 * Wrapped, not scrolled sideways: in a sideways ScrollView, iOS lays the text out far taller than its lines.
 */
function CodeBlock({ text, lang, ink, fill }: { text: string; lang: string | undefined; ink: string; fill: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = () => {
    void Clipboard.setStringAsync(text);
    haptics.success();
    setCopied(true);
  };
  const label = lang === undefined || lang === "" ? "Code" : lang;
  return (
    <Pressable onPress={copy} accessibilityRole="button" accessibilityLabel={`${label}: ${text}`} accessibilityHint="Copies the code">
      {({ pressed }) => (
        <View style={[styles.codeBlock, { backgroundColor: fill }, pressed && styles.codePressed]}>
          <View style={styles.codeHead}>
            <Text style={[type.caption, styles.codeLang, { color: ink }]}>{label}</Text>
            <View style={styles.copy}>
              <Icon name={copied ? "done" : "copy"} size={12} color={ink} weight="semibold" />
              <Text style={[type.caption, styles.codeLang, { color: ink }]}>{copied ? "Copied" : "Copy"}</Text>
            </View>
          </View>
          <Text style={[styles.code, { color: ink }]}>{text}</Text>
        </View>
      )}
    </Pressable>
  );
}

/** A table's rule between columns, and its edge fade's width where it is clipped. */
const GAP = space.md;
const FADE = 40;

/** Tables measured, by their cells, text size and screen width: one laid out again (a list's row remounting) draws at once. */
const laidOut = new Map<string, { columns: Measured[]; room: number }>();

/**
 * A table: the desktop's table block, laid out in table.ts. First its cells draw on one line each, column by column, as
 * wide as they are, and each column and its longest word report their widths; then the rows draw at the widths that
 * fit the room, long cells wrapping, every row's cells side by side so a wrapped cell keeps its row together. A table
 * that still doesn't fit scrolls sideways, out to the edges of what holds it (`bleed`, its padding), and fades into its
 * `ground` on the side with more. Locked to its direction, so a vertical swipe on it still scrolls the chat. While
 * `settled` is off (the words still stream in), it stays on one line, scrolling, so it doesn't reflow with each row.
 */
export function Grid({
  header,
  rows,
  ink,
  rule,
  onAccent = false,
  ground,
  bleed,
  settled = true,
}: {
  header: ReadonlyArray<readonly Inline[]>;
  rows: ReadonlyArray<ReadonlyArray<readonly Inline[]>>;
  ink: string;
  rule: string;
  onAccent?: boolean;
  ground: string;
  bleed: number;
  settled?: boolean;
}) {
  const { width: screen, fontScale } = useWindowDimensions();
  const key = `${String(fontScale)}:${String(screen)}:${JSON.stringify([header, rows])}`;
  const columns = useMemo(() => header.map((h, c) => ({ cells: rows.map((r) => r[c] ?? []), head: longestWord([h]), word: longestWord(rows.map((r) => r[c] ?? [])) })), [header, rows]);
  const numeric = useMemo(() => columns.map((c) => isNumeric(c.cells)), [columns]);
  const [, setLaid] = useState("");
  const [edges, setEdges] = useState({ left: false, right: true });
  // The latest of each: a view reports its size only when it changes, so a row streaming in that leaves a column as
  // wide as it was reports nothing for it.
  const sizes = useRef<{ natural: number[]; head: number[]; word: number[]; room?: number }>({ natural: [], head: [], word: [] });
  const laid = settled ? laidOut.get(key) : undefined;
  const finish = () => {
    if (!settled || laidOut.has(key)) return;
    const s = sizes.current;
    const n = header.length;
    for (let c = 0; c < n; c++) if (s.natural[c] === undefined || s.head[c] === undefined || s.word[c] === undefined) return;
    if (s.room === undefined) return;
    if (laidOut.size > 200) laidOut.clear();
    laidOut.set(key, { columns: columns.map((_, c) => ({ natural: s.natural[c] ?? 0, word: Math.max(s.head[c] ?? 0, s.word[c] ?? 0), numeric: numeric[c] === true })), room: s.room });
    setLaid(key);
  };
  const take = (put: (s: typeof sizes.current) => void) => {
    put(sizes.current);
    finish();
  };
  // Settling reports no sizes: the words stopped streaming in, and the table already drew.
  useEffect(() => finish(), [settled, key]);
  if (header.length === 0) return null;
  const cellStyle = (c: number) => [type.footnote, styles.cell, { color: ink }, numeric[c] === true && styles.num];
  const inline = (nodes: readonly Inline[]) => <Inlines nodes={nodes} ink={ink} onAccent={onAccent} small />;

  if (laid === undefined)
    return (
      <View key="measure" style={{ marginHorizontal: -bleed }} onLayout={(e) => take((s) => (s.room = e.nativeEvent.layout.width - 2 * bleed))}>
        <ScrollView horizontal directionalLockEnabled scrollsToTop={false} showsHorizontalScrollIndicator={false} style={styles.sideways} contentContainerStyle={{ paddingHorizontal: bleed }}>
          <View style={styles.columns}>
            {columns.map((col, c) => {
              const last = c === header.length - 1;
              const pad = last ? null : { paddingRight: GAP };
              return (
                <View key={c} onLayout={(e) => take((s) => (s.natural[c] = e.nativeEvent.layout.width - (last ? 0 : GAP)))}>
                  <Text style={[cellStyle(c), styles.head, styles.ruled, pad, { borderBottomColor: rule }]}>{inline(header[c] ?? [])}</Text>
                  {col.cells.map((cell, row) => (
                    <Text key={row} style={[cellStyle(c), styles.ruled, pad, { borderBottomColor: row === rows.length - 1 ? "transparent" : rule }]}>
                      {inline(cell)}
                    </Text>
                  ))}
                  <View style={styles.measure} onLayout={(e) => take((s) => (s.head[c] = e.nativeEvent.layout.width))}>
                    <Text style={[type.footnote, styles.head, col.head.code && styles.cellCode]}>{col.head.text}</Text>
                  </View>
                  <View style={styles.measure} onLayout={(e) => take((s) => (s.word[c] = e.nativeEvent.layout.width))}>
                    <Text style={[type.footnote, col.word.code && styles.cellCode]}>{col.word.text}</Text>
                  </View>
                </View>
              );
            })}
          </View>
        </ScrollView>
      </View>
    );

  const { widths, scrolls } = columnWidths(laid.columns, laid.room, GAP);
  const line = (cells: ReadonlyArray<readonly Inline[]>, head: boolean, border: string, i: number) => (
    <View key={i} style={[styles.row, { borderBottomColor: border }]}>
      {widths.map((w, c) => (
        <Text key={c} style={[cellStyle(c), head && styles.head, { width: w }, c < widths.length - 1 && { marginRight: GAP }]} selectable={!head}>
          {inline(cells[c] ?? [])}
        </Text>
      ))}
    </View>
  );
  const clear = clearOf(ground);
  return (
    <View key="laid" style={{ marginHorizontal: -bleed }}>
      <ScrollView
        horizontal
        scrollEnabled={scrolls}
        bounces={scrolls}
        directionalLockEnabled
        scrollsToTop={false}
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          const next = { left: contentOffset.x > 1, right: contentOffset.x + layoutMeasurement.width < contentSize.width - 1 };
          if (next.left !== edges.left || next.right !== edges.right) setEdges(next);
        }}
        style={styles.sideways}
        contentContainerStyle={{ paddingHorizontal: bleed }}
      >
        <View>
          {line(header, true, rule, -1)}
          {rows.map((r, i) => line(r, false, i === rows.length - 1 ? "transparent" : rule, i))}
        </View>
      </ScrollView>
      {scrolls && edges.left ? <LinearGradient pointerEvents="none" start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} colors={[ground, clear]} style={[styles.fade, styles.fadeLeft]} /> : null}
      {scrolls && edges.right ? <LinearGradient pointerEvents="none" start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} colors={[clear, ground]} style={[styles.fade, styles.fadeRight]} /> : null}
    </View>
  );
}

/** A color at no opacity, for a fade into it: a fade to plain "transparent" (clear black) greys on the way. */
const clearOf = (color: string): string => {
  const hex = /^#([0-9a-f]{6})$/iu.exec(color)?.[1];
  if (hex !== undefined) {
    const n = Number.parseInt(hex, 16);
    return `rgba(${String((n >> 16) & 255)},${String((n >> 8) & 255)},${String(n & 255)},0)`;
  }
  return color.replace(/^rgba\(([^,]+),([^,]+),([^,]+),[^)]+\)$/u, "rgba($1,$2,$3,0)");
};

/** Opens an artifact link's artifact (`artifact:<name>[@<version>]`): the chat it is in provides it; elsewhere such a link reads as its words. */
export const ArtifactLinks = createContext<((url: string) => boolean) | undefined>(undefined);

/** `small`: in a table's cell, its code a step smaller to sit in the cell's smaller type, and kept on one line. */
function Inlines({ nodes, ink, onAccent, small = false }: { nodes: readonly Inline[]; ink: string; onAccent: boolean; small?: boolean }) {
  const t = useTheme();
  const openArtifact = useContext(ArtifactLinks);
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case "text":
            return <Fragment key={i}>{n.text}</Fragment>;
          case "code":
            return (
              <Text key={i} style={[styles.inlineCode, small && styles.cellCode, { backgroundColor: onAccent ? "rgba(255,255,255,0.18)" : t.fillQuiet }]}>
                {small ? n.text.replace(/ /gu, "\u00A0") : n.text}
              </Text>
            );
          case "strong":
            return (
              <Text key={i} style={styles.strong}>
                <Inlines nodes={n.children} ink={ink} onAccent={onAccent} small={small} />
              </Text>
            );
          case "em":
            return (
              <Text key={i} style={styles.em}>
                <Inlines nodes={n.children} ink={ink} onAccent={onAccent} small={small} />
              </Text>
            );
          case "del":
            return (
              <Text key={i} style={styles.del}>
                <Inlines nodes={n.children} ink={ink} onAccent={onAccent} small={small} />
              </Text>
            );
          case "link":
            if (n.url.startsWith("artifact:") && openArtifact === undefined) return <Inlines key={i} nodes={n.children} ink={ink} onAccent={onAccent} small={small} />;
            return (
              <Text
                key={i}
                accessibilityRole="link"
                onPress={() => {
                  if (n.url.startsWith("artifact:")) openArtifact?.(n.url);
                  else void Linking.openURL(n.url);
                }}
                style={onAccent ? styles.underline : [styles.underline, { color: t.link }]}
              >
                <Inlines nodes={n.children} ink={ink} onAccent={onAccent} small={small} />
              </Text>
            );
        }
      })}
    </>
  );
}

const styles = StyleSheet.create({
  blocks: { gap: 10 },
  code: { fontFamily: mono, fontSize: 14, lineHeight: 20 },
  codeBlock: { borderRadius: 12, borderCurve: "continuous", paddingHorizontal: 12, paddingTop: 8, paddingBottom: 10, gap: 6 },
  unshown: { flexDirection: "row", alignItems: "center", gap: 6, opacity: 0.7 },
  codePressed: { opacity: 0.7 },
  codeHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  codeLang: { fontWeight: "600", opacity: 0.6 },
  copy: { flexDirection: "row", alignItems: "center", gap: 4 },
  inlineCode: { fontFamily: mono, fontSize: 15 },
  quote: { borderLeftWidth: 3, paddingLeft: 10, gap: space.xs },
  list: { gap: 4 },
  item: { flexDirection: "row", gap: 6 },
  marker: { minWidth: 14 },
  // Shrinks to fit, but keeps its width: the bubble sizes to its longest line, as iMessage's does.
  itemText: { flexShrink: 1 },
  // Not grown: a sideways ScrollView fills the height it's given, which in a bubble is far too much.
  sideways: { flexGrow: 0 },
  rule: { height: StyleSheet.hairlineWidth, marginVertical: space.xs },
  strong: { fontWeight: "600" },
  em: { fontStyle: "italic" },
  del: { textDecorationLine: "line-through" },
  underline: { textDecorationLine: "underline" },
  columns: { flexDirection: "row" },
  row: { flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth },
    cell: { paddingVertical: 6 },
  // The measuring pass's cells draw their own rule, so it runs on under the gap to the next column.
  ruled: { borderBottomWidth: StyleSheet.hairlineWidth },
  head: { fontWeight: "600" },
  // Numbers right-aligned, their figures one width, as the desktop's.
  num: { textAlign: "right", fontVariant: ["tabular-nums"] },
  cellCode: { fontFamily: mono, fontSize: 12 },
  // A word measured on its own: no height, and only as wide as it is.
  measure: { height: 0, overflow: "hidden", alignSelf: "flex-start" },
  fade: { position: "absolute", top: 0, bottom: 0, width: FADE },
  fadeLeft: { left: 0 },
  fadeRight: { right: 0 },
});
