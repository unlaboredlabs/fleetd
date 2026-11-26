// A JSON document folded: its top level open, everything under it a line that says what it holds (`{ 4 keys }`,
// `[ 120 items ]`) and opens on a click or Enter. A long list shows its first hundred, then a hundred more at a time.
// Values in the code voice's colours.
import { ChevronRight } from "lucide-react";
import { createContext, useContext, useState } from "react";
import { cx } from "../../ui";
import f from "./files.module.css";

type Json = null | boolean | number | string | readonly Json[] | { readonly [k: string]: Json };

/** How deep the tree opens by itself: the top level. `Infinity` is Unfold all. */
const OpenTo = createContext(1);

const PAGE = 100;

const isBranch = (v: Json): v is readonly Json[] | { readonly [k: string]: Json } => typeof v === "object" && v !== null;

const what = (v: readonly Json[] | { readonly [k: string]: Json }): string => {
  if (Array.isArray(v)) return `[ ${String(v.length)} ${v.length === 1 ? "item" : "items"} ]`;
  const n = Object.keys(v).length;
  return `{ ${String(n)} ${n === 1 ? "key" : "keys"} }`;
};

/** A folded object's first plain values, to tell it from its neighbours: `id: "wh-001", city: "Oslo", …`. */
export const peek = (v: Json, room = 60): string => {
  if (!isBranch(v) || Array.isArray(v)) return "";
  const parts: string[] = [];
  let used = 0;
  for (const [k, x] of Object.entries(v)) {
    if (isBranch(x)) continue;
    const part = `${k}: ${typeof x === "string" ? JSON.stringify(x.length > 24 ? `${x.slice(0, 23)}…` : x) : String(x)}`;
    if (used + part.length > room && parts.length > 0) {
      parts.push("…");
      break;
    }
    parts.push(part);
    used += part.length + 2;
  }
  return parts.join(", ");
};

function Leaf({ v }: { v: Exclude<Json, readonly Json[] | { readonly [k: string]: Json }> }) {
  if (typeof v === "string") return <span className={f.jsonString}>{JSON.stringify(v)}</span>;
  if (typeof v === "number") return <span className={f.jsonNumber}>{String(v)}</span>;
  return <span className={f.jsonConstant}>{String(v)}</span>;
}

function Node({ name, v, depth }: { name: string | undefined; v: Json; depth: number }) {
  const openTo = useContext(OpenTo);
  const [open, setOpen] = useState(depth < openTo);
  const [shown, setShown] = useState(PAGE);
  const key = name === undefined ? null : <span className={f.jsonKey}>{name}</span>;
  if (!isBranch(v)) {
    return (
      <div className={f.jsonLine} style={{ paddingLeft: depth * 16 + 16 }}>
        {key}
        {key !== null ? <span className={f.jsonPunct}>: </span> : null}
        <Leaf v={v} />
      </div>
    );
  }
  const entries: readonly (readonly [string | undefined, Json])[] = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v);
  return (
    <>
      <button type="button" className={cx(f.jsonLine, f.jsonBranch)} style={{ paddingLeft: depth * 16 }} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <ChevronRight className={cx(f.jsonChevron, open && f.jsonOpen)} aria-hidden />
        {key}
        {key !== null ? <span className={f.jsonPunct}>: </span> : null}
        <span className={f.jsonPunct}>{open ? (Array.isArray(v) ? "[" : "{") : what(v)}</span>
        {!open && peek(v) !== "" ? <span className={f.jsonPeek}>{peek(v)}</span> : null}
      </button>
      {open ? (
        <>
          {entries.slice(0, shown).map(([k, x]) => (
            <Node key={k} name={k} v={x} depth={depth + 1} />
          ))}
          {entries.length > shown ? (
            <button type="button" className={cx(f.jsonLine, f.jsonMore)} style={{ paddingLeft: (depth + 1) * 16 + 16 }} onClick={() => setShown((n) => n + PAGE)}>
              {`Show ${String(Math.min(PAGE, entries.length - shown))} more of ${String(entries.length - shown)}`}
            </button>
          ) : null}
          <div className={cx(f.jsonLine, f.jsonPunct)} style={{ paddingLeft: depth * 16 + 16 }}>
            {Array.isArray(v) ? "]" : "}"}
          </div>
        </>
      ) : null}
    </>
  );
}

/** The document, folded to `openTo` levels; a new `openTo` (Unfold all, Fold all) folds it again from there. */
export function JsonTree({ value, openTo }: { value: unknown; openTo: number }) {
  return (
    <OpenTo.Provider value={openTo}>
      <div className={f.json} key={openTo}>
        <Node name={undefined} v={value as Json} depth={0} />
      </div>
    </OpenTo.Provider>
  );
}
