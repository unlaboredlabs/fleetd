// A bubble's markdown (markdown.ts) as native text: code in monospace, links that open in the browser, lists with
// hanging bullets, tables that scroll sideways. `ink` is the bubble's text color; on the accent, links are underlined
// in it rather than drawn in the accent. A bubble's words aren't selectable where they stand, as in Messages: holding
// one opens its menu, whose Select Text has them.
import * as Clipboard from "expo-clipboard";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Linking, PixelRatio, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View, type TextLayoutEvent, type TextStyle } from "react-native";
import { parseMarkdown, type Block, type Inline } from "../markdown";
import { bubble, fitWidth } from "../bubble";
import { mono, space, type, useTheme } from "../theme";
import { haptics } from "./haptics";
import { Icon } from "./Icon";

/**
 * `fit`: the words take only as wide as their longest line, as Messages' bubbles do, where a Text takes all the width it
 * may. Paragraphs and headings measure their lines once for each text and text size, then draw at that width; other
 * blocks (a list, code) keep the whole width. Off while the text still streams in, so the bubble doesn't narrow and
 * widen with each word. Turning it on, or a new text size, lays the words out afresh at the whole width to measure them.
 */
export function Markdown({ text, ink, onAccent = false, fit = false }: { text: string; ink: string; onAccent?: boolean; fit?: boolean }) {
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
        <BlockView key={i} block={b} ink={ink} onAccent={onAccent} onLines={fits ? measure(i) : undefined} />
      ))}
    </View>
  );
}

function BlockView({ block, ink, onAccent, onLines }: { block: Block; ink: string; onAccent: boolean; onLines?: ((e: TextLayoutEvent) => void) | undefined }) {
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
      return <CodeBlock text={block.text} lang={block.lang} ink={ink} fill={codeFill} />;
    case "quote":
      return (
        <View style={[styles.quote, { borderLeftColor: onAccent ? "rgba(255,255,255,0.5)" : t.tertiary }]}>
          {block.blocks.map((b, i) => (
            <BlockView key={i} block={b} ink={ink} onAccent={onAccent} />
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
      return (
        // Not grown: a sideways ScrollView fills the height it's given, which in a bubble is far too much.
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.sideways}>
          <Grid header={block.header.map((c) => <Inlines nodes={c} ink={ink} onAccent={onAccent} />)} rows={block.rows.map((r) => r.map((c) => <Inlines nodes={c} ink={ink} onAccent={onAccent} />))} ink={ink} rule={onAccent ? "rgba(255,255,255,0.3)" : t.separator} />
        </ScrollView>
      );
  }
}

/**
 * Fenced code: its language and a Copy button over it, and a tap anywhere on it copies it, as Telegram's code blocks.
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

/** A table's cells, column by column so each column takes its widest cell. */
export function Grid({ header, rows, ink, rule }: { header: readonly ReactNode[]; rows: ReadonlyArray<readonly ReactNode[]>; ink: string; rule: string }) {
  return (
    <View style={styles.grid}>
      {header.map((h, col) => (
        <View key={col} style={styles.column}>
          <Text style={[type.footnote, styles.cell, styles.head, { color: ink, borderBottomColor: rule }]} numberOfLines={1}>
            {h}
          </Text>
          {rows.map((r, row) => (
            <Text key={row} style={[type.footnote, styles.cell, { color: ink, borderBottomColor: row === rows.length - 1 ? "transparent" : rule }]} numberOfLines={1} selectable>
              {r[col] ?? ""}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

function Inlines({ nodes, ink, onAccent }: { nodes: readonly Inline[]; ink: string; onAccent: boolean }) {
  const t = useTheme();
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case "text":
            return <Fragment key={i}>{n.text}</Fragment>;
          case "code":
            return (
              <Text key={i} style={[styles.inlineCode, { backgroundColor: onAccent ? "rgba(255,255,255,0.18)" : t.fillQuiet }]}>
                {n.text}
              </Text>
            );
          case "strong":
            return (
              <Text key={i} style={styles.strong}>
                <Inlines nodes={n.children} ink={ink} onAccent={onAccent} />
              </Text>
            );
          case "em":
            return (
              <Text key={i} style={styles.em}>
                <Inlines nodes={n.children} ink={ink} onAccent={onAccent} />
              </Text>
            );
          case "del":
            return (
              <Text key={i} style={styles.del}>
                <Inlines nodes={n.children} ink={ink} onAccent={onAccent} />
              </Text>
            );
          case "link":
            return (
              <Text
                key={i}
                accessibilityRole="link"
                onPress={() => void Linking.openURL(n.url)}
                style={onAccent ? styles.underline : [styles.underline, { color: t.accent }]}
              >
                <Inlines nodes={n.children} ink={ink} onAccent={onAccent} />
              </Text>
            );
        }
      })}
    </>
  );
}

const styles = StyleSheet.create({
  blocks: { gap: space.sm },
  code: { fontFamily: mono, fontSize: 14, lineHeight: 19 },
  codeBlock: { borderRadius: 12, borderCurve: "continuous", paddingHorizontal: 12, paddingTop: 8, paddingBottom: 10, gap: 6 },
  codePressed: { opacity: 0.7 },
  codeHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  codeLang: { fontWeight: "600", opacity: 0.6 },
  copy: { flexDirection: "row", alignItems: "center", gap: 4 },
  inlineCode: { fontFamily: mono, fontSize: 15 },
  quote: { borderLeftWidth: 3, paddingLeft: 10, gap: space.xs },
  list: { gap: 2 },
  item: { flexDirection: "row", gap: 6 },
  marker: { minWidth: 14 },
  // Shrinks to fit, but keeps its width: the bubble sizes to its longest line, as iMessage's does.
  itemText: { flexShrink: 1 },
  sideways: { flexGrow: 0 },
  rule: { height: StyleSheet.hairlineWidth, marginVertical: space.xs },
  strong: { fontWeight: "600" },
  em: { fontStyle: "italic" },
  del: { textDecorationLine: "line-through" },
  underline: { textDecorationLine: "underline" },
  grid: { flexDirection: "row" },
  column: { flexShrink: 0 },
  cell: { paddingVertical: 6, paddingRight: space.lg, borderBottomWidth: StyleSheet.hairlineWidth, maxWidth: 220 },
  head: { fontWeight: "600" },
});
