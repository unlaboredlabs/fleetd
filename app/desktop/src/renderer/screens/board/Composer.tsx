// The composer docked on the board: "What should the fleet do?". Where above the box (project, type), what inside,
// how below (attach, mention, Enter). Enter sends and keeps focus; Shift+Enter adds a line. The rules live in
// composerLogic.ts; this file is the box.
import { useEffect, useId, useImperativeHandle, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type Ref } from "react";
import { AtSign, Paperclip } from "lucide-react";
import {
  Button,
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
  Text,
  Truncate,
  cx,
} from "../../ui";
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  PASTE_AS_FILE,
  PREVIEW_PAUSE_MS,
  TEMPLATES,
  TEMPLATE_HINT,
  TEMPLATE_LABEL,
  type MentionItem,
  type Target,
  checkText,
  fmtBytes,
  mentionAt,
  mentionItems,
  mentionRef,
  mentionText,
  mimeFor,
  projectPrefix,
  resolveTarget,
  templateFromPrefix,
  wantsPreview,
} from "./composerLogic";
import type { IntakeRef, PlaybookName } from "./contracts";
import c from "./Composer.module.css";

export interface Draft {
  readonly target: string | undefined;
  readonly template: PlaybookName;
  readonly text: string;
  readonly attachments: readonly string[];
  readonly refs: readonly IntakeRef[];
}

export type Upload = { readonly ok: true; readonly id: string } | { readonly ok: false; readonly message: string };

/** What the composer asks of the hub. Each never rejects. */
export interface ComposerApi {
  /** The router's guess for this text: a project key, or undefined when it can't place it. */
  preview(text: string): Promise<string | undefined>;
  files(target: Target, query: string): Promise<readonly string[]>;
  upload(name: string, mime: string, dataB64: string): Promise<Upload>;
  send(draft: Draft): void;
  addProject(): void;
}

export interface ComposerHandle {
  focus(): void;
  /** Puts text in the box (Edit on a failed order, the palette's "New order: …"). */
  setText(text: string): void;
}

export interface ComposerProps {
  readonly targets: readonly Target[];
  /** The project the board is filtered to: the default target. */
  readonly selected?: string | undefined;
  readonly lastUsed?: string | undefined;
  readonly orders: readonly { id: string; title: string }[];
  readonly prs: readonly { number: number; url: string; title: string }[];
  /** Why Send is off, e.g. "Not connected; retrying in 4 s". */
  readonly offline?: string | undefined;
  readonly api: ComposerApi;
  readonly handle?: Ref<ComposerHandle> | undefined;
  readonly autoFocus?: boolean;
}

interface Attached {
  readonly local: number;
  readonly name: string;
  readonly bytes: number;
  readonly upload?: Upload;
}

interface MentionMenu {
  readonly start: number;
  readonly query: string;
  readonly selected: number;
}

const toBase64 = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

const looksText = (buf: ArrayBuffer): boolean => {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(buf).subarray(0, 4096));
    return true;
  } catch {
    return false;
  }
};

export function Composer(props: ComposerProps) {
  const { targets, api } = props;
  const box = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [text, setText] = useState("");
  const [chosen, setChosen] = useState<string | null | undefined>(undefined);
  const [template, setTemplate] = useState<PlaybookName | undefined>(undefined);
  const [attached, setAttached] = useState<readonly Attached[]>([]);
  const [refs, setRefs] = useState<readonly { ref: IntakeRef; chip: string }[]>([]);
  const [menu, setMenu] = useState<MentionMenu | undefined>(undefined);
  const [files, setFiles] = useState<{ query: string; paths: readonly string[] } | undefined>(undefined);
  const [guess, setGuess] = useState<{ text: string; key: string | undefined } | undefined>(undefined);
  const [guessing, setGuessing] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const nextLocal = useRef(0);
  const pastes = useRef(0);

  useImperativeHandle(props.handle, () => ({
    focus: () => box.current?.focus(),
    setText: (t: string) => {
      setText(t);
      box.current?.focus();
    },
  }));

  useEffect(() => {
    if (props.autoFocus) box.current?.focus();
  }, [props.autoFocus]);

  const target = resolveTarget({ chosen, text, targets, selected: props.selected, guess: guess?.key, lastUsed: props.lastUsed });
  const targetRow = targets.find((t) => t.key === target.key);
  const kind = template ?? templateFromPrefix(text) ?? "feature";

  // The router's guess, after a pause, only while nothing else decides the project.
  const lastPreview = guess?.text ?? "";
  const wantGuess = chosen === undefined && props.selected === undefined && projectPrefix(text, targets) === undefined && wantsPreview(text, lastPreview);
  useEffect(() => {
    if (!wantGuess) return;
    const t = window.setTimeout(() => {
      const asked = text.trim();
      setGuessing(true);
      void api.preview(asked).then((key) => {
        setGuess({ text: asked, key });
        setGuessing(false);
      });
    }, PREVIEW_PAUSE_MS);
    return () => window.clearTimeout(t);
  }, [wantGuess, text, api]);

  // The @ menu's files, for the target project.
  const query = menu?.query;
  useEffect(() => {
    if (query === undefined || !targetRow) return;
    let live = true;
    const t = window.setTimeout(() => {
      void api.files(targetRow, query).then((paths) => {
        if (live) setFiles({ query, paths });
      });
    }, 120);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [query, targetRow, api]);

  const items: MentionItem[] = menu
    ? mentionItems(menu.query, files?.query === menu.query ? files.paths : [], props.orders, props.prs)
    : [];

  const onChange = (value: string, caret: number) => {
    setText(value);
    setError(undefined);
    const m = mentionAt(value, caret);
    setMenu((old) => (m ? { ...m, selected: old?.start === m.start && old.query === m.query ? old.selected : 0 } : undefined));
  };

  const pick = (item: MentionItem | undefined) => {
    const el = box.current;
    if (!item || !menu || !el) return setMenu(undefined);
    const caret = el.selectionStart;
    const insert = `${mentionText(item)} `;
    const next = text.slice(0, menu.start) + insert + text.slice(caret);
    setText(next);
    const ref = mentionRef(item);
    if (!refs.some((r) => JSON.stringify(r.ref) === JSON.stringify(ref))) {
      setRefs([...refs, { ref, chip: item.kind === "file" ? (item.path.split("/").at(-1) ?? item.path) : mentionText(item) }]);
    }
    setMenu(undefined);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(menu.start + insert.length, menu.start + insert.length);
    });
  };

  const attach = (list: readonly File[]) => {
    // Counted as files are taken: `attached` is the list from before this drop.
    let count = attached.length;
    for (const file of list) {
      if (count >= MAX_ATTACHMENTS) return setError(`At most ${MAX_ATTACHMENTS} attachments per order.`);
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setError(`${file.name} is ${fmtBytes(file.size)}; attachments are at most 5 MB.`);
        continue;
      }
      count++;
      const local = nextLocal.current++;
      setAttached((a) => [...a, { local, name: file.name, bytes: file.size }]);
      void file.arrayBuffer().then(async (buf) => {
        const mime = mimeFor(file.name, looksText(buf));
        if (!mime) {
          setAttached((a) => a.filter((x) => x.local !== local));
          setError(`${file.name}: only images, text and PDF files attach.`);
          return;
        }
        const upload = await api.upload(file.name, mime, toBase64(buf));
        setAttached((a) => a.map((x) => (x.local === local ? { ...x, upload } : x)));
      });
    }
  };

  const send = () => {
    if (props.offline) return;
    const checked = checkText(text);
    if (!checked.ok) return setError(checked.reason);
    const ids: string[] = [];
    for (const a of attached) {
      if (!a.upload) return setError(`${a.name} is still uploading.`);
      if (!a.upload.ok) return setError(`${a.name} didn't upload: ${a.upload.message} Remove it to send.`);
      ids.push(a.upload.id);
    }
    api.send({ target: target.key, template: kind, text: checked.text, attachments: ids, refs: refs.map((r) => r.ref) });
    setText("");
    setAttached([]);
    setRefs([]);
    setTemplate(undefined);
    setMenu(undefined);
    setGuess(undefined);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (menu && items.length > 0) {
      const step = (by: number) => setMenu({ ...menu, selected: (menu.selected + by + items.length) % items.length });
      const by = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
      if (by !== 0 || e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (by !== 0) step(by);
        else pick(items[menu.selected]);
        return;
      }
    }
    if (e.key === "Escape") {
      if (menu) return setMenu(undefined);
      e.currentTarget.blur();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      send();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const fileList = [...e.clipboardData.files];
    if (fileList.length > 0) {
      e.preventDefault();
      return attach(fileList);
    }
    const pasted = e.clipboardData.getData("text/plain");
    if (pasted.length > PASTE_AS_FILE) {
      e.preventDefault();
      pastes.current += 1;
      attach([new File([pasted], `pasted-${pastes.current}.txt`, { type: "text/plain" })]);
    }
  };

  const onDrop = (e: DragEvent) => {
    if (e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    attach([...e.dataTransfer.files]);
  };

  const source =
    target.source === "guess"
      ? "guess"
      : target.source === "any" && chosen === undefined
        ? "the hub picks"
        : target.source === "last"
          ? "last used"
          : undefined;
  const sendable = text.trim() !== "" && !props.offline;

  return (
    <div className={c.composer} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <Text as="h2" strong className={cx(c.heading)}>
        What should the fleet do?
      </Text>
      <div className={c.where}>
        <span className={c.quiet}>to</span>
        <Menu>
          <MenuTrigger asChild>
            <button type="button" className={c.picker} aria-label="Project">
              <Truncate expand="none" size="xs" tone="inherit">
                {targetRow?.title ?? "Any project"}
              </Truncate>
              <span aria-hidden>▾</span>
            </button>
          </MenuTrigger>
          <MenuContent>
            <MenuRadioGroup value={chosen === undefined ? "" : (chosen ?? "any")} onValueChange={(v) => setChosen(v === "any" ? null : v)}>
              <MenuRadioItem value="any" hint="the hub picks">
                Any project
              </MenuRadioItem>
              {targets.map((t) => (
                <MenuRadioItem key={t.key} value={t.key} hint={t.offline ? `${t.machine} · offline` : t.machine}>
                  {t.title}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
            <MenuSeparator />
            <MenuItem onSelect={() => api.addProject()}>Add project…</MenuItem>
          </MenuContent>
        </Menu>
        {targetRow ? <span className={c.quiet}>on {targetRow.machine}{targetRow.offline ? " (offline)" : ""}</span> : null}
        {source ? <span className={c.quiet}>· {source}</span> : null}
        {guessing && chosen === undefined ? <span className={c.quiet}>· guessing…</span> : null}
        <Menu>
          <MenuTrigger asChild>
            <button type="button" className={cx(c.picker, c.type)} aria-label="Type">
              {TEMPLATE_LABEL[kind]} <span aria-hidden>▾</span>
            </button>
          </MenuTrigger>
          <MenuContent>
            <MenuRadioGroup value={kind} onValueChange={(v) => setTemplate(TEMPLATES.find((t) => t === v))}>
              {TEMPLATES.map((t) => (
                <MenuRadioItem key={t} value={t} hint={TEMPLATE_HINT[t]}>
                  {TEMPLATE_LABEL[t]}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuContent>
        </Menu>
      </div>
      <div className={c.field}>
        <textarea
          ref={box}
          // The demo recorder (FLEETD_DEMO_TYPE) types the order here once it can take focus.
          data-composer="ready"
          className={c.input}
          rows={1}
          value={text}
          placeholder="What should the fleet do?"
          aria-label="What should the fleet do?"
          aria-autocomplete="list"
          aria-expanded={menu !== undefined && items.length > 0}
          aria-controls={listId}
          onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
          onSelect={(e) => {
            const el = e.currentTarget;
            const m = mentionAt(el.value, el.selectionStart);
            if (!m && menu) setMenu(undefined);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        {menu && items.length > 0 ? (
          <ul id={listId} role="listbox" className={c.menu} aria-label="Mention">
            {items.map((item, i) => (
              <li
                key={`${item.kind}:${mentionText(item)}`}
                role="option"
                aria-selected={i === menu.selected}
                className={cx(c.option, i === menu.selected && c.selected)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(item);
                }}
              >
                <span className={c.optionKind}>{item.kind === "file" ? "File" : item.kind === "order" ? "Order" : "PR"}</span>
                <Truncate expand="none" size="sm" mono={item.kind === "file"} tone="inherit">
                  {item.kind === "file" ? item.path : item.kind === "order" ? `${item.id} ${item.title}` : `#${item.number} ${item.title}`}
                </Truncate>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {attached.length > 0 || refs.length > 0 ? (
        <div className={c.chips}>
          {attached.map((a) => (
            <span key={a.local} className={cx(c.chip, a.upload && !a.upload.ok && c.failed)}>
              <Truncate expand="none" size="xs" tone="inherit">
                {`${a.name} · ${a.upload ? (a.upload.ok ? fmtBytes(a.bytes) : "failed") : "uploading…"}`}
              </Truncate>
              <button type="button" className={c.remove} aria-label={`Remove ${a.name}`} onClick={() => setAttached(attached.filter((x) => x.local !== a.local))}>
                ×
              </button>
            </span>
          ))}
          {refs.map((r) => (
            <span key={r.chip} className={c.chip}>
              <Truncate expand="none" size="xs" tone="inherit">
                {r.chip}
              </Truncate>
              <button type="button" className={c.remove} aria-label={`Remove ${r.chip}`} onClick={() => setRefs(refs.filter((x) => x !== r))}>
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className={c.how}>
        <Button variant="quiet" icon={<Paperclip />} onClick={() => fileInput.current?.click()}>
          Attach
        </Button>
        <Button
          variant="quiet"
          icon={<AtSign />}
          onClick={() => {
            const el = box.current;
            if (!el) return;
            const at = el.selectionStart;
            const pre = text.slice(0, at);
            const insert = pre === "" || /\s$/u.test(pre) ? "@" : " @";
            onChange(pre + insert + text.slice(at), at + insert.length);
            requestAnimationFrame(() => {
              el.focus();
              el.setSelectionRange(at + insert.length, at + insert.length);
            });
          }}
        >
          Mention
        </Button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            attach([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <span className={c.spacer} />
        {error ? (
          <Text size="xs" tone="danger" className={cx(c.error)}>
            {error}
          </Text>
        ) : props.offline ? (
          <Text size="xs" tone="warning" className={cx(c.error)}>
            {props.offline}
          </Text>
        ) : (
          <span className={c.keys}>Enter send · ⇧Enter newline</span>
        )}
        <Button variant="primary" disabled={!sendable} onClick={send}>
          Send
        </Button>
      </div>
    </div>
  );
}
