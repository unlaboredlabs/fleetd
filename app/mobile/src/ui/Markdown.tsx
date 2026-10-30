// A bubble's markdown (markdown.ts) as native text: code in monospace, links that open in the browser, lists with
// hanging bullets, tables that scroll sideways. `ink` is the bubble's text color; on the accent, links are underlined
// in it rather than drawn in the accent. A bubble's words aren't selectable where they stand, as in Messages: holding
// one opens its menu, whose Select Text has them.
import * as Clipboard from "expo-clipboard";
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View, type TextStyle } from "react-native";
import { parseMarkdown, type Block, type Inline } from "../markdown";
import { mono, space, type, useTheme } from "../theme";
import { haptics } from "./haptics";
import { Icon } from "./Icon";

/**
 * `room`: words as wide as the bubble's time, kept clear at the end of the last line (invisible), so the time sits in
 * the corner beside the text as Telegram's does. A last block that isn't a paragraph gets a line of its own for it.
 */
export function Markdown({ text, ink, onAccent = false, room }: { text: string; ink: string; onAccent?: boolean; room?: string | undefined }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const lastIsText = blocks.at(-1)?.t === "p";
  return (
    <View style={styles.blocks}>
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} ink={ink} onAccent={onAccent} room={i === blocks.length - 1 ? room : undefined} />
      ))}
      {room !== undefined && !lastIsText ? <View style={styles.roomLine} /> : null}
    </View>
  );
}

function BlockView({ block, ink, onAccent, room }: { block: Block; ink: string; onAccent: boolean; room?: string | undefined }) {
  const t = useTheme();
  const codeFill = onAccent ? "rgba(255,255,255,0.18)" : t.fillQuiet;
  const base: TextStyle = { ...type.body, color: ink };
  switch (block.t) {
    case "p":
      return (
        <Text style={base}>
          <Inlines nodes={block.inline} ink={ink} onAccent={onAccent} />
          {room === undefined ? null : (
            <Text style={[type.caption2, styles.room]} accessible={false}>
              {`\u2002\u2002${room}`}
            </Text>
          )}
        </Text>
      );
    case "h":
      return (
        <Text style={[base, block.level <= 2 ? type.title3 : type.headline, { color: ink }]} accessibilityRole="header">
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
  room: { color: "transparent" },
  roomLine: { height: 6 },
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
