// A file sent in the chat, shown in the wide panel the way an artifact is (`artifacts/file/<id>`): a CSV or a sheet as
// a table to select in, Markdown rendered, JSON folded, a PDF's pages, text and code with line numbers, a picture
// fit to the panel. Its head names it and holds Open in app (the desktop's) and Save. It reads only what it shows, in
// ranges (source.ts): a table's first rows, a note's first megabyte, the PDF pages in view; what it cut short says
// so under it. Word, PowerPoint and zips open in this computer's app instead (FileCard); a link to one here says so.
import { Download, ExternalLink, WrapText } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ProjectRef } from "../../../shared/contracts";
import { glyphOf, kindOf } from "../../../shared/files";
import { PREVIEW_SIDE } from "../../../shared/transfer";
import { useDataLayer, useToolQuery } from "../../src/data/react";
import { onWeb } from "../../src/web";
import { Button, Markdown, Text, toast, Tooltip } from "../../ui";
import { fmtBytes } from "../chat/attachments";
import { GLYPHS } from "../chat/blocks/FileCard";
import type { ProjectKey } from "../shell/routes";
import { parseDelimited, type Rows } from "./csv";
import { JsonTree } from "./JsonTree";
import { kindWord } from "./cardKind";
import { MAX_ROWS, READ_CAP, showOf, type FileShow } from "./kind";
import { PdfView } from "./PdfView";
import { fileSource, type FileSource } from "./source";
import { Table } from "./Table";
import { TextView } from "./TextView";
import { openWorkbook, readSheet, type Workbook } from "./xlsx";
import a from "../artifacts/artifacts.module.css";
import f from "./files.module.css";

/** A kind as a noun in a sentence: "Word document", "zip archive". */
const kindNoun = (mime: string): string => {
  const k = kindOf(mime);
  return /^(Zip|File|Text|Image)/u.test(k) ? k.toLowerCase() : k;
};

/** Text from a file's first bytes; `cut` drops the line the cut fell in. */
const decode = (bytes: Uint8Array, cut: boolean): string => {
  const text = new TextDecoder().decode(bytes);
  if (!cut) return text;
  const end = text.lastIndexOf("\n");
  return end > 0 ? text.slice(0, end + 1) : text;
};

type Loaded =
  | { readonly as: "rows"; readonly rows: Rows; readonly cut: boolean }
  | { readonly as: "sheet"; readonly book: Workbook }
  | { readonly as: "text"; readonly text: string; readonly cut: boolean }
  | { readonly as: "json"; readonly value: unknown }
  | { readonly as: "none" };

const load = async (source: FileSource, show: FileShow, size: number): Promise<Loaded> => {
  switch (show.as) {
    case "table": {
      const bytes = await source.upTo(READ_CAP.table);
      const cut = size > bytes.length;
      return { as: "rows", rows: parseDelimited(decode(bytes, false), show.sep, MAX_ROWS, cut), cut };
    }
    case "sheet":
      return { as: "sheet", book: await openWorkbook({ size, range: source.range }) };
    case "json": {
      if (size <= READ_CAP.json) {
        const text = decode(await source.upTo(size), false);
        try {
          return { as: "json", value: JSON.parse(text) as unknown };
        } catch {
          // Not JSON after all: its words, as text.
          return { as: "text", text: text.slice(0, READ_CAP.text), cut: text.length > READ_CAP.text };
        }
      }
      const bytes = await source.upTo(READ_CAP.text);
      return { as: "text", text: decode(bytes, true), cut: true };
    }
    case "markdown":
    case "code":
    case "text": {
      const bytes = await source.upTo(READ_CAP.text);
      const cut = size > bytes.length;
      return { as: "text", text: decode(bytes, cut), cut };
    }
    default:
      return { as: "none" };
  }
};

type Head = Awaited<ReturnType<FileSource["head"]>>;

export function FileView({ project, attachmentId }: { project: ProjectKey; attachmentId: string }) {
  const { hub, call } = useDataLayer();
  const ref = useMemo((): ProjectRef => ({ machineId: project.machineId, projectId: project.projectId }), [project.machineId, project.projectId]);
  // A try again reads with a fresh source: one that failed keeps its failed first piece.
  const [source, setSource] = useState(() => fileSource(call, ref, attachmentId));
  const again = () => setSource(fileSource(call, ref, attachmentId));
  // What was read, of the source it was read from: a new source shows nothing read until its own reads land.
  const [got, setGot] = useState<{ readonly source: FileSource; readonly head?: Head | { error: string }; readonly loaded?: Loaded | { error: string } }>({ source });
  const head = got.source === source ? got.head : undefined;
  const loaded = got.source === source ? got.loaded : undefined;

  useEffect(() => {
    let live = true;
    // Asked after each wait: the view may have gone meanwhile.
    const alive = () => live;
    void source
      .head()
      .then(async (h) => {
        if (!alive()) return;
        setGot({ source, head: h });
        const out = await load(source, showOf(h.name, h.mime), h.size);
        if (alive()) setGot({ source, head: h, loaded: out });
      })
      .catch((e: unknown) => {
        const error = { error: e instanceof Error ? e.message : String(e) };
        if (alive()) setGot((g) => ({ source, head: g.source === source && g.head !== undefined ? g.head : error, loaded: error }));
      });
    return () => {
      live = false;
    };
  }, [source]);

  const [busy, setBusy] = useState(false);
  const act = async (what: "open" | "save") => {
    if (busy || head === undefined || "error" in head) return;
    setBusy(true);
    const request = { projectRef: ref, attachmentId };
    const out = await (what === "open" ? window.fleetd.files.open(hub, request) : window.fleetd.files.save(hub, request)).catch((e: unknown) => ({ ok: false as const, message: String(e) }));
    setBusy(false);
    if (!out.ok) toast({ tone: "danger", title: what === "open" ? `Couldn’t open ${head.name}` : `Couldn’t save ${head.name}`, description: out.message });
  };

  const web = onWeb();
  const rest = web ? "Save it for the rest." : "Open it in its app for the rest.";
  const [sheet, setSheet] = useState(0);
  const [openTo, setOpenTo] = useState({ depth: 1, n: 0 });
  const [wrap, setWrap] = useState<boolean | undefined>(undefined);

  if (head === undefined || "error" in head) {
    return (
      <div className={a.screen} data-screen={head === undefined ? "file.loading" : "file.error"}>
        {head === undefined ? (
          <div className={a.skeleton} aria-busy="true" aria-label="Loading the file">
            <span />
            <span />
          </div>
        ) : (
          <div className={a.note} role="alert">
            <Text tone="quiet">{`Couldn’t read the file. ${head.error}`}</Text>
            <Button onClick={() => again()}>Try again</Button>
          </div>
        )}
      </div>
    );
  }

  const show = showOf(head.name, head.mime);
  const Glyph = GLYPHS[glyphOf(head.mime)];
  const wrapped = wrap ?? (show.as !== "code");
  const tools: ReactNode[] = [];
  if (loaded !== undefined && !("error" in loaded) && loaded.as === "json") {
    tools.push(
      <Button key="unfold" size="sm" variant="quiet" onClick={() => setOpenTo((o) => ({ depth: Number.POSITIVE_INFINITY, n: o.n + 1 }))}>
        Unfold all
      </Button>,
      <Button key="fold" size="sm" variant="quiet" onClick={() => setOpenTo((o) => ({ depth: 1, n: o.n + 1 }))}>
        Fold all
      </Button>,
    );
  }
  if (loaded !== undefined && !("error" in loaded) && loaded.as === "text" && show.as !== "markdown") {
    tools.push(
      <Tooltip key="wrap" content={wrapped ? "Don’t wrap lines" : "Wrap lines"}>
        <Button size="sm" variant="quiet" iconOnly className={f.toggle} aria-label="Wrap lines" aria-pressed={wrapped} onClick={() => setWrap(!wrapped)}>
          <WrapText />
        </Button>
      </Tooltip>,
    );
  }

  let body: ReactNode;
  if (loaded === undefined) {
    body = show.as === "pdf" ? null : (
      <div className={a.skeleton} aria-busy="true" aria-label="Loading the file">
        <span />
        <span />
      </div>
    );
  } else if ("error" in loaded) {
    body = (
      <div className={a.note} role="alert">
        <Text tone="quiet">{loaded.error}</Text>
        <Button onClick={() => again()}>Try again</Button>
      </div>
    );
  }
  if (show.as === "pdf") body = <PdfView source={source} size={head.size} first={head.first} />;
  else if (show.as === "image") body = <Picture project={ref} attachmentId={attachmentId} name={head.name} />;
  else if (show.as === "app")
    body = (
      <div className={a.note}>
        <Text tone="quiet">{web ? `Save this ${kindNoun(head.mime)} to open it.` : `This ${kindNoun(head.mime)} opens in its own app.`}</Text>
        {!web ? (
          <Button variant="secondary" disabled={busy} onClick={() => void act("open")}>
            Open in app
          </Button>
        ) : null}
        <Button variant="secondary" disabled={busy} onClick={() => void act("save")}>
          Save
        </Button>
      </div>
    );
  else if (loaded !== undefined && !("error" in loaded)) {
    switch (loaded.as) {
      case "rows":
        body = <Table rows={loaded.rows.rows} more={loaded.rows.more} note={loaded.rows.more ? `Showing the first ${MAX_ROWS.toLocaleString()} rows or ${fmtBytes(READ_CAP.table)}. ${rest}` : undefined} />;
        break;
      case "sheet":
        body = <SheetView key={sheet} source={source} size={head.size} book={loaded.book} sheet={sheet} onSheet={setSheet} rest={rest} />;
        break;
      case "json":
        body = (
          <div className={a.scroll}>
            <JsonTree key={openTo.n} value={loaded.value} openTo={openTo.depth} />
          </div>
        );
        break;
      case "text":
        body = (
          <div className={a.scroll}>
            {show.as === "markdown" ? (
              <div className={a.doc}>
                <Markdown source={loaded.text} blocks={false} />
              </div>
            ) : (
              <TextView text={loaded.text} lang={show.as === "code" ? show.lang : null} wrap={wrapped} />
            )}
            {loaded.cut ? (
              <Text size="xs" tone="quiet" className={f.cutNote}>
                {`Showing the first ${fmtBytes(READ_CAP.text)} of ${fmtBytes(head.size)}. ${rest}`}
              </Text>
            ) : null}
          </div>
        );
        break;
      default:
        break;
    }
  }

  return (
    <div className={a.screen} data-screen={`file.${show.as}`}>
      <header className={a.head}>
        <div className={f.title}>
          <Glyph className={f.titleGlyph} aria-hidden />
          <Text as="h2" size="lg" className={a.heading}>
            {head.name}
          </Text>
          <span className={f.headActions}>
            {!web && show.as !== "app" ? (
              <Tooltip content="Open in this computer’s app for it">
                <Button size="sm" variant="quiet" icon={<ExternalLink aria-hidden />} disabled={busy} onClick={() => void act("open")}>
                  Open in app
                </Button>
              </Tooltip>
            ) : null}
            <Tooltip content="Save…">
              <Button size="sm" variant="quiet" iconOnly icon={<Download />} aria-label={`Save ${head.name}`} disabled={busy} onClick={() => void act("save")} />
            </Tooltip>
          </span>
        </div>
        <div className={a.toolbar}>
          <Text size="xs" tone="quiet" tabular>
            {`${kindWord(head.name, head.mime)} · ${fmtBytes(head.size)}`}
          </Text>
          {tools.length > 0 ? <span className={f.tools}>{tools}</span> : null}
        </div>
      </header>
      {body}
    </div>
  );
}

function SheetView(props: { source: FileSource; size: number; book: Workbook; sheet: number; onSheet: (sheet: number) => void; rest: string }) {
  const { source, size, book, sheet, onSheet, rest } = props;
  const [rows, setRows] = useState<Rows | { error: string } | undefined>(undefined);
  const one = book.sheets[sheet];
  useEffect(() => {
    if (one === undefined) return;
    let live = true;
    readSheet({ size, range: source.range }, book, one, MAX_ROWS).then(
      (r) => live && setRows(r),
      (e: unknown) => live && setRows({ error: e instanceof Error ? e.message : "This sheet couldn’t be read." }),
    );
    return () => {
      live = false;
    };
  }, [source, size, book, one]);
  if (one === undefined) {
    return (
      <div className={a.note}>
        <Text tone="quiet">This workbook has no sheets to show.</Text>
      </div>
    );
  }
  if (rows === undefined)
    return (
      <div className={a.skeleton} aria-busy="true" aria-label="Loading the sheet">
        <span />
        <span />
      </div>
    );
  if ("error" in rows)
    return (
      <div className={a.note} role="alert">
        <Text tone="quiet">{rows.error}</Text>
      </div>
    );
  // The workbook's sheets as a spreadsheet shows them: tabs along the foot.
  const tabs =
    book.sheets.length > 1 ? (
      <span className={f.sheets} role="tablist" aria-label="Sheets">
        {book.sheets.map((s, i) => (
          <button key={s.name} type="button" role="tab" aria-selected={i === sheet} className={f.sheet} onClick={() => onSheet(i)}>
            {s.name}
          </button>
        ))}
      </span>
    ) : undefined;
  return <Table rows={rows.rows} more={rows.more} tabs={tabs} note={rows.more ? `Showing the first ${MAX_ROWS.toLocaleString()} rows. ${rest}` : undefined} />;
}

/** A picture linked here rather than opened in the viewer: fit to the panel. */
function Picture({ project, attachmentId, name }: { project: ProjectRef; attachmentId: string; name: string }) {
  const got = useToolQuery("attachment_get", { projectRef: project, attachmentId, maxSide: 2 * PREVIEW_SIDE.desktop });
  return (
    <div className={f.picture}>
      {got.data !== undefined ? <img src={`data:${got.data.mime};base64,${got.data.dataB64}`} alt={name} /> : <Text tone="quiet">{got.isError ? "Couldn’t load this." : "Loading…"}</Text>}
    </div>
  );
}
