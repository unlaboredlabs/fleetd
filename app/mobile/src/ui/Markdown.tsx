// A bubble's markdown (markdown.ts) as native text: code in monospace, links that open in the browser, lists with
// hanging bullets, tables that scroll sideways. `ink` is the bubble's text color; on the accent, links are underlined
// in it rather than drawn in the accent.
import { Fragment, useMemo, type ReactNode } from "react";
import { Linking, ScrollView, StyleSheet, Text, View, type TextStyle } from "react-native";
import { parseMarkdown, type Block, type Inline } from "../markdown";
import { mono, space, type, useTheme } from "../theme";

export function Markdown({ text, ink, onAccent = false }: { text: string; ink: string; onAccent?: boolean }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <View style={styles.blocks}>
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} ink={ink} onAccent={onAccent} />
      ))}
    </View>
  );
}

function BlockView({ block, ink, onAccent }: { block: Block; ink: string; onAccent: boolean }) {
  const t = useTheme();
  const codeFill = onAccent ? "rgba(255,255,255,0.18)" : t.fillQuiet;
  const base: TextStyle = { ...type.body, color: ink };
  switch (block.t) {
    case "p":
      return (
        <Text style={base} selectable>
          <Inlines nodes={block.inline} ink={ink} onAccent={onAccent} />
        </Text>
      );
    case "h":
      return (
        <Text style={[base, block.level <= 2 ? type.title3 : type.headline, { color: ink }]} accessibilityRole="header" selectable>
          <Inlines nodes={block.inline} ink={ink} onAccent={onAccent} />
        </Text>
      );
    case "code":
      return (
        // Wrapped, not scrolled sideways: in a sideways ScrollView, iOS lays the text out far taller than its lines.
        <View style={[styles.codeBlock, { backgroundColor: codeFill }]}>
          <Text style={[styles.code, { color: ink }]} selectable>
            {block.text}
          </Text>
        </View>
      );
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
              <Text style={[base, styles.itemText]} selectable>
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
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <Grid header={block.header.map((c) => <Inlines nodes={c} ink={ink} onAccent={onAccent} />)} rows={block.rows.map((r) => r.map((c) => <Inlines nodes={c} ink={ink} onAccent={onAccent} />))} ink={ink} rule={onAccent ? "rgba(255,255,255,0.3)" : t.separator} />
        </ScrollView>
      );
  }
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
  codeBlock: { borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8 },
  inlineCode: { fontFamily: mono, fontSize: 15 },
  quote: { borderLeftWidth: 3, paddingLeft: 10, gap: space.xs },
  list: { gap: 2 },
  item: { flexDirection: "row", gap: 6 },
  marker: { minWidth: 14 },
  itemText: { flex: 1 },
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
