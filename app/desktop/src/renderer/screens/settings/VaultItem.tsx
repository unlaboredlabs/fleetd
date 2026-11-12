// One vault item, beside the list: its mark, title and line on top; then its fields, each as dots until the person
// asks. Show asks for Touch ID (or a confirm where there is none, main/vault.ts) and shows every field for 30 seconds;
// the window losing focus, another item or leaving the page hides them at once. Copy never brings a value here: main
// copies it and empties the clipboard a minute later. A plain variable shows as it is. Then the sites it fills on, its
// last 20 uses (vault_get's activity) with All activity, and Edit and Delete for whoever may change it (a team item's
// creator or an admin); anyone else reads why they're not there. An item in the trash says until when, with Restore
// and Delete now.
import { Copy, Eye, EyeOff, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { VaultAuditEntry, VaultItemSummary } from "../../../shared/contracts";
import { Button, Dialog, InlineCode, Text, toast } from "../../ui";
import { useDataLayer, useToolQuery } from "../../src/data/react";
import { when } from "../live/when";
import { useHubCall, useLive, useRefetch } from "./hub";
import { DangerButton, GroupNote, SettingsList, SettingsListRow, SettingsRow, SettingsSection } from "./parts";
import { useProjectName, VAULT_READS, vaultError } from "./vaultParts";
import { VaultEditor } from "./VaultForms";
import {
  auditLine,
  fieldsOf,
  isSecretEnv,
  orderTag,
  presentFields,
  REVEAL_MS,
  rowLine,
  sealedFields,
  shownFields,
  sitesMeta,
  titleOf,
  vaultErrorWords,
  type FieldSpec,
} from "./vaultModel";
import s from "./settings.module.css";
import v from "./vault.module.css";

const DOTS = "••••••••";

/** Hides a revealed value when the window loses focus or the page is hidden. */
function useHideOnBlur(hide: () => void) {
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === "hidden") hide();
    };
    window.addEventListener("blur", hide);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("blur", hide);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, [hide]);
}

export function VaultItemPanel({ listed, onGone, onClose }: { listed: VaultItemSummary; onGone: () => void; onClose: () => void }) {
  const live = useLive();
  const { hub } = useDataLayer();
  const read = useToolQuery("vault_get", { itemId: listed.itemId }, { enabled: live });
  const item = read.data?.item ?? listed;
  const projectName = useProjectName();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [allActivity, setAllActivity] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // The values on screen, and when they go. Nothing else holds them.
  const [shown, setShown] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hide = useCallback(() => {
    clearTimeout(timer.current);
    setShown(null);
  }, []);
  useHideOnBlur(hide);
  useEffect(() => hide, [hide]);

  const plain = item.kind === "env" && !isSecretEnv(item);
  const trashed = item.deletedMs !== undefined;
  const fields = presentFields(item);
  const title = titleOf(item);

  const show = () => {
    setBusy(true);
    setProblem(null);
    void window.fleetd.vault.reveal(hub, { itemId: item.itemId, label: title, fields: sealedFields(item.kind) }).then((out) => {
      setBusy(false);
      if (!out.ok) {
        if (out.error.code !== "cancelled") setProblem(`Couldn't show it: ${vaultErrorWords(out.error) ?? out.error.message}`);
        return;
      }
      clearTimeout(timer.current);
      setShown(shownFields(item.kind, out.fields));
      timer.current = setTimeout(hide, REVEAL_MS);
    });
  };

  const copy = (f: FieldSpec) => {
    setProblem(null);
    if (plain) {
      void window.fleetd.copy(item.value ?? "").then(() => toast({ title: `Copied ${title}` }));
      return;
    }
    void window.fleetd.vault.copy(hub, { itemId: item.itemId, label: `${title}'s ${f.label.toLowerCase()}`, field: f.key }).then((out) => {
      if (out.ok) toast({ title: `Copied the ${f.label.toLowerCase()}`, description: "It leaves the clipboard in a minute." });
      else if (out.error.code !== "cancelled") setProblem(`Couldn't copy it: ${vaultErrorWords(out.error) ?? out.error.message}`);
    });
  };

  const valueOf = (f: FieldSpec) => (plain ? (item.value ?? "") : shown?.[f.key]);
  const order = orderTag(item);
  const line = [item.kind === "env" ? (isSecretEnv(item) ? "Secret variable" : "Plain variable") : rowLine(item), order === undefined ? undefined : `Order ${order}`].filter(Boolean).join(" · ");
  const sink = item.kind === "env" ? item.meta.sink : undefined;
  return (
    <SettingsSection
      title={title}
      intro={line}
      data={{ "data-vault-item": item.itemId }}
      aside={
        <div className={s.inline}>
          {plain || !item.canReveal || trashed ? null : shown === null ? (
            <Button size="sm" variant="ghost" icon={<Eye size={14} />} disabled={!live || busy} onClick={show}>
              {busy ? "Showing…" : "Show"}
            </Button>
          ) : (
            <Button size="sm" variant="ghost" icon={<EyeOff size={14} />} onClick={hide}>
              Hide
            </Button>
          )}
          {item.canEdit && !trashed ? (
            <Button size="sm" variant="secondary" disabled={!live} onClick={() => (hide(), setEditing(true))}>
              Edit
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" iconOnly aria-label="Close" title="Close" onClick={onClose}>
            <X />
          </Button>
        </div>
      }
    >
      {trashed ? <TrashPart item={item} onGone={onGone} /> : null}
      {(plain ? fieldsOf("env") : fields).map((f) => {
        const value = valueOf(f);
        return (
          <SettingsRow
            key={f.key}
            title={f.label}
            data={{ "data-revealed": value === undefined ? undefined : "" }}
            line={value === undefined ? <span aria-label="Hidden">{DOTS}</span> : value === "" ? "Empty" : <span className={v.value}>{value}</span>}
            control={
              (plain || item.canReveal) && !trashed && value !== "" ? (
                <Button size="sm" variant="ghost" iconOnly aria-label={`Copy the ${f.label.toLowerCase()}`} title="Copy" disabled={!live} onClick={() => copy(f)}>
                  <Copy />
                </Button>
              ) : undefined
            }
          />
        );
      })}
      {!item.canReveal && !plain && !trashed ? (
        <GroupNote>{item.kind === "env" ? "Only its creator or an admin can show it. Agents still get it." : "Only its creator or an admin can show it. Agents still fill it."}</GroupNote>
      ) : null}
      {problem === null ? null : (
        <div role="alert">
          <GroupNote tone="danger">{problem}</GroupNote>
        </div>
      )}
      {item.kind === "login" || item.kind === "address" ? <SitesRow item={item} /> : null}
      {sink === undefined ? null : (
        <SettingsRow
          title="Also written to"
          line={
            <>
              {sink.kind === "file" ? "The file " : sink.envName === undefined ? "A line of " : (
                <>
                  <InlineCode>{sink.envName}</InlineCode>
                  {" in "}
                </>
              )}
              <InlineCode>{sink.path}</InlineCode>
              {` on ${sink.machineId}`}
            </>
          }
        />
      )}
      <SourceRow item={item} />
      <ActivityRow entries={read.data?.activity} projectName={projectName} onAll={() => setAllActivity(true)} />
      {item.canEdit && !trashed ? (
        <SettingsRow
          title="Delete"
          hint={item.kind === "env" ? "Agents stop getting it from their next start. It stays in the trash for 30 days." : "Agents can't use it any more. It stays in the trash for 30 days."}
          control={
            <DangerButton disabled={!live} onClick={() => setDeleting(true)}>
              Delete…
            </DangerButton>
          }
        />
      ) : !item.canEdit && !trashed ? (
        <GroupNote>{item.kind === "env" ? "Changing it needs operate on the project." : "Only its creator or an admin can change or delete it."}</GroupNote>
      ) : null}

      {editing ? <VaultEditor kind={item.kind} item={item} onClose={() => setEditing(false)} onSaved={() => setEditing(false)} /> : null}
      {deleting ? <DeleteDialog item={item} onClose={() => setDeleting(false)} onDeleted={onGone} /> : null}
      {allActivity ? <ActivityDialog item={item} onClose={() => setAllActivity(false)} /> : null}
    </SettingsSection>
  );
}

function SitesRow({ item }: { item: VaultItemSummary }) {
  const sites = sitesMeta(item);
  return (
    <SettingsRow
      title={item.kind === "login" ? "Fills on" : "Sites"}
      line={
        sites.length === 0
          ? item.kind === "login"
            ? "No site: agents can't fill it anywhere. Edit it to add the site it signs in to."
            : "Fills at checkouts, and on sites the vault has a login for."
          : `${sites.join(", ")}, and their subdomains.`
      }
    />
  );
}

function SourceRow({ item }: { item: VaultItemSummary }) {
  const src = item.meta.source;
  const [now] = useState(() => Date.now());
  if (src.kind === "typed") return null;
  return (
    <SettingsRow
      title="From"
      hint={src.kind === "1password" ? "1Password isn't asked again for it." : undefined}
      line={src.kind === "1password" ? `Imported from 1Password (${when(new Date(src.importedMs).toISOString(), now)}).` : `Moved into the vault from ${src.from}.`}
    />
  );
}

/** One use, as a row of a list: what happened, where and by whom, and when. Never a value. */
function UseRow({ entry, projectName, now }: { entry: VaultAuditEntry; projectName: (m: string, p: string) => string | undefined; now: number }) {
  const line = auditLine(entry, projectName);
  const bad = entry.outcome === "refused" || entry.outcome === "failed";
  return (
    <SettingsListRow name={line.title} label={line.title} {...(bad ? { state: { word: entry.outcome, tone: "danger" as const } } : {})} controls={<Text size="sm" tone="quiet" tabular>{when(new Date(entry.atMs).toISOString(), now)}</Text>}>
      {line.detail === undefined ? null : (
        <Text size="sm" tone="quiet">
          {line.detail}
        </Text>
      )}
    </SettingsListRow>
  );
}

function ActivityRow({ entries, projectName, onAll }: { entries: readonly VaultAuditEntry[] | undefined; projectName: (m: string, p: string) => string | undefined; onAll: () => void }) {
  const [now] = useState(() => Date.now());
  return (
    <SettingsRow
      title="Activity"
      line={entries === undefined ? "Loading…" : entries.length === 0 ? "Not used yet." : undefined}
      control={
        entries !== undefined && entries.length >= 20 ? (
          <Button size="sm" variant="secondary" onClick={onAll}>
            All activity
          </Button>
        ) : undefined
      }
    >
      {entries === undefined || entries.length === 0 ? null : (
        <SettingsList label="Recent uses">
          {entries.map((e) => (
            <UseRow key={e.n} entry={e} projectName={projectName} now={now} />
          ))}
        </SettingsList>
      )}
    </SettingsRow>
  );
}

/** Every use, newest first, a page at a time. */
function ActivityDialog({ item, onClose }: { item: VaultItemSummary; onClose: () => void }) {
  const projectName = useProjectName();
  const [before, setBefore] = useState<number[]>([]);
  const page = useToolQuery("vault_audit", { itemId: item.itemId, limit: 100, ...(before.length === 0 ? {} : { before: before[before.length - 1] }) });
  const [now] = useState(() => Date.now());
  const entries = page.data?.entries ?? [];
  const last = entries[entries.length - 1];
  return (
    <Dialog open wide onOpenChange={(o) => (o ? undefined : onClose())} title={`${titleOf(item)}: all activity`} footer={<Button onClick={onClose}>Done</Button>}>
      {page.isLoadingError ? (
        <Text tone="danger">{vaultError(page.error)}</Text>
      ) : page.data === undefined ? (
        <Text tone="quiet">Loading…</Text>
      ) : (
        <SettingsList label="Every use">
          {entries.map((e) => (
            <UseRow key={e.n} entry={e} projectName={projectName} now={now} />
          ))}
        </SettingsList>
      )}
      <div className={s.inline}>
        {before.length > 0 ? (
          <Button size="sm" variant="ghost" onClick={() => setBefore((b) => b.slice(0, -1))}>
            Newer
          </Button>
        ) : null}
        {page.data?.more === true && last !== undefined ? (
          <Button size="sm" variant="ghost" onClick={() => setBefore((b) => [...b, last.n])}>
            Older
          </Button>
        ) : null}
      </div>
    </Dialog>
  );
}

export function DeleteDialog({ item, onClose, onDeleted }: { item: VaultItemSummary; onClose: () => void; onDeleted: () => void }) {
  const call = useHubCall();
  const refetch = useRefetch();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const remove = () => {
    setBusy(true);
    call("vault_delete", { itemId: item.itemId }).then(
      () => {
        refetch([...VAULT_READS]);
        toast({ title: `Deleted ${titleOf(item)}`, description: "It's in the trash for 30 days." });
        onDeleted();
      },
      (e: unknown) => {
        setBusy(false);
        setProblem(vaultError(e));
      },
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      title={`Delete ${titleOf(item)}?`}
      description={
        item.kind === "env"
          ? "Agents stop getting it from their next start; running ones keep it until then. It stays in the trash for 30 days."
          : "Agents can't use it any more. It stays in the trash for 30 days."
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy} onClick={remove}>
            {busy ? "Deleting…" : "Delete"}
          </Button>
        </>
      }
    >
      {problem === null ? null : (
        <Text size="sm" tone="danger">
          {problem}
        </Text>
      )}
    </Dialog>
  );
}

/** In the trash: until when, Restore, and Delete now. */
function TrashPart({ item, onGone }: { item: VaultItemSummary; onGone: () => void }) {
  const call = useHubCall();
  const refetch = useRefetch();
  const [problem, setProblem] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const gone = (item.deletedMs ?? now) + 30 * 86_400_000;
  const act = (what: "restore" | "purge") => {
    setProblem(null);
    (what === "restore" ? call("vault_restore", { itemId: item.itemId }) : call("vault_delete", { itemId: item.itemId, purge: true })).then(
      () => {
        refetch([...VAULT_READS]);
        toast({ title: what === "restore" ? `Restored ${titleOf(item)}` : `${titleOf(item)} is gone for good` });
        onGone();
      },
      (e: unknown) => setProblem(vaultError(e)),
    );
  };
  return (
    <SettingsRow
      title="In the trash"
      hint="Agents can't use it while it's here."
      line={`Gone for good on ${when(new Date(gone).toISOString(), now)}.`}
      control={
        item.canEdit ? (
          <>
            <Button size="sm" variant="secondary" onClick={() => act("restore")}>
              Restore
            </Button>
            <DangerButton size="sm" onClick={() => act("purge")}>
              Delete now
            </DangerButton>
          </>
        ) : undefined
      }
    >
      {problem === null ? null : (
        <Text size="sm" tone="danger">
          {problem}
        </Text>
      )}
    </SettingsRow>
  );
}
