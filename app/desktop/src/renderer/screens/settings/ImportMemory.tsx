// You › Your memory › Import memory (W229): bring what another assistant knows about you. Two steps, as plain as the
// phone's: copy the hub's export prompt (memory_import without text) into ChatGPT, Claude or Grok, paste its answer
// back, and Add to Memory sends it (memory_import with text). The hub reads it in a model turn on your own Claude, in
// your own Navi only (someone with none is sent to create one), and writes the entries to your memory itself; this
// says how many went in, and names any that didn't fit.
import { useState } from "react";
import type { MemoryImportOutput } from "../../../shared/contracts";
import { Button, copyText, Text, Textarea } from "../../ui";
import { lacksTool } from "../../src/data/errors";
import { CallError } from "../../src/data/queries";
import { useToolQuery } from "../../src/data/react";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import { PagePart } from "./parts";
import m from "./Memory.module.css";
import s from "./settings.module.css";

/** The hub's fix for someone with no Navi, where every import runs so nobody else reads the paste (import.rs). */
export const NO_NAVI_FIX = "Create a Navi first, then import again.";

/** The model turn can take a minute or two; the hub stops it at four. */
const IMPORT_TIMEOUT_MS = 300_000;

const entries = (n: number) => (n === 1 ? "1 entry" : `${String(n)} entries`);

/** What an import did, in a line: how many went in, then what was skipped and why. */
export function importSummary(out: MemoryImportOutput): string {
  const count = (why: string) => out.skipped.filter((x) => x.why === why).length;
  // "Already says it" only when what it skipped was all already there; a full memory or a secret says otherwise.
  const head =
    out.added.length > 0
      ? `Added ${entries(out.added.length)} to your memory.`
      : count("full") > 0
        ? "Nothing was added: none of it fit under your memory's cap."
        : out.skipped.length === 0
          ? "Nothing to add: the answer held nothing about you."
          : count("duplicate") === out.skipped.length
            ? "Nothing new to add: your memory already says it."
            : "Nothing was added.";
  const skipped = [
    count("duplicate") > 0 ? `${String(count("duplicate"))} already there` : null,
    count("secret") > 0 ? `${String(count("secret"))} holding a secret` : null,
  ].filter((p) => p !== null);
  return skipped.length > 0 ? `${head} Skipped ${skipped.join(", ")}.` : head;
}

export function ImportMemory() {
  const live = useLive();
  const read = useToolQuery("memory_import", {}, { enabled: live });
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const [text, setText] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<MemoryImportOutput | null>(null);
  const [error, setError] = useState<{ text: string; noNavi: boolean } | null>(null);

  // A hub from before Import memory has no such call: the section isn't there.
  if (!live || (read.error instanceof CallError && lacksTool(read.error.error))) return null;
  const prompt = read.data?.prompt;

  const copy = () => {
    if (!prompt) return;
    void copyText(prompt).then((ok) => {
      setCopied(ok);
      if (ok) window.setTimeout(() => setCopied(false), 1500);
    });
  };
  const add = () => {
    if (text.trim() === "" || busy) return;
    setBusy(true);
    setDone(null);
    setError(null);
    hubCall("memory_import", { text }, { timeoutMs: IMPORT_TIMEOUT_MS }).then(
      (out) => {
        setBusy(false);
        setDone(out);
        setText("");
        refetch(["memory_get"]);
      },
      (e: unknown) => {
        setBusy(false);
        const noNavi = e instanceof CallError && e.error.fix === NO_NAVI_FIX;
        setError({ text: noNavi && e instanceof CallError ? e.error.message : errorText(e), noNavi });
      },
    );
  };
  const full = done?.skipped.filter((x) => x.why === "full") ?? [];

  return (
    <PagePart title="Import memory" reveal="import-memory" intro="Bring what another AI assistant knows about you, so you don't teach it all again.">
      <ol className={m.steps}>
        <li className={s.stack}>
          <Text size="sm" tone="quiet">
            1. Copy this prompt into a chat with your other AI assistant
          </Text>
          <div className={m.promptCard}>
            {read.isLoadingError ? (
              <Text size="sm" tone="danger">
                {errorText(read.error)}
              </Text>
            ) : (
              // The prompt exactly as it is copied, markdown included: a code view to the QA text rule.
              <div data-text="code" className={m.promptBody}>
                <Text size="sm" tone="quiet" className={m.promptText}>
                  {prompt ?? "Loading…"}
                </Text>
              </div>
            )}
            <div className={m.promptFoot}>
              <Button variant="link" size="sm" disabled={!prompt} onClick={copy}>
                {copied ? "Copied" : "Copy prompt"}
              </Button>
            </div>
          </div>
        </li>
        <li className={s.stack}>
          <Text size="sm" tone="quiet">
            2. Paste the answer below to add it to your memory
          </Text>
          <Textarea aria-label="The other assistant's answer" placeholder="Paste your memory details here" value={text} minRows={6} maxRows={16} disabled={busy} onChange={(e) => setText(e.target.value)} />
        </li>
      </ol>
      <div className={s.stack}>
        <div className={s.actions}>
          <Button variant="primary" disabled={text.trim() === "" || busy} onClick={add}>
            {busy ? "Adding to Memory…" : "Add to Memory"}
          </Button>
          {busy ? (
            <Text size="xs" tone="quiet">
              Reading it on your Claude; this can take a minute.
            </Text>
          ) : null}
        </div>
        <div role="status">
          {error ? (
            <Text size="sm" tone="danger">
              {error.text}
              {error.noNavi ? (
                <>
                  {" "}
                  <a href="#/navi">Create a Navi</a>, then import again.
                </>
              ) : null}
            </Text>
          ) : done ? (
            <div className={s.stack}>
              <Text size="sm">{importSummary(done)}</Text>
              {full.length > 0 ? (
                <>
                  <Text size="xs" tone="quiet">
                    {entries(full.length)} didn&apos;t fit under your memory&apos;s cap of {done.cap.toLocaleString()} characters, so the more lasting ones went in first. Trim your memory, then import again to add these:
                  </Text>
                  <ul className={m.leftOut} aria-label="Left out">
                    {full.map((x) => (
                      <li key={x.text}>
                        <Text size="xs" tone="quiet">
                          {x.text}
                        </Text>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </PagePart>
  );
}
