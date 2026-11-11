// Settings › You › Vault, a project's Vault tab and Hub › Every project › Vault (vault-design §8): the logins, cards, addresses and
// variables agents fill and get without ever seeing them, as Passwords lays them out. A search field and a filter by
// kind above the list; the open item beside it (VaultItem.tsx); one plus menu to add each kind, paste a .env or import
// from 1Password (VaultImport.tsx); the trash under the list. Yours lists your own items and the hub's; a project's,
// its own and its orders'; the hub's, those every project uses, with the vault key's state for its owners and admins.
// The lists hold metadata alone (vault_list): a value reaches this page only when the person reveals it, and leaves
// it on a timer or as soon as the window loses focus.
import { ArrowLeft, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { VaultItemSummary, VaultKind, VaultStatusOutput } from "../../../shared/contracts";
import { Button, Dialog, Field, InlineCode, Input, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Segmented, Text, toast } from "../../ui";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { useAdministers } from "../admin/role";
import { navigate } from "../shell/navigation";
import { useHubCall, useLive, useRefetch } from "./hub";
import { AddButton, GroupNote, PageHead, SettingsList, SettingsListRow, SettingsRow, SettingsSection } from "./parts";
import { useReveal } from "./reveal";
import { VaultItemPanel } from "./VaultItem";
import { KIND_ICON, useProjectName, VAULT_READS, vaultError } from "./vaultParts";
import { ImportDialog, PasteEnvDialog, VaultEditor } from "./VaultForms";
import { FILTERS, kindWords, listInput, onPage, rowLine, scopeTag, shownItems, titleOf, vaultErrorWords, vaultServed, type Filter, type Whose } from "./vaultModel";
import s from "./settings.module.css";
import v from "./vault.module.css";

/** What the plus menu opened. */
type Adding = { readonly kind: "item"; readonly item: VaultKind } | { readonly kind: "paste" } | { readonly kind: "import" };

const PAGE_WORDS: Readonly<Record<Whose["kind"], { screen: string }>> = {
  mine: {
    screen: "settings.vault",
  },
  project: {
    screen: "settings.project-vault",
  },
  hub: {
    screen: "settings.hub.vault",
  },
};

export function VaultPage({ whose }: { whose: Whose }) {
  const served = useData((st) => vaultServed(st.features));
  if (!served) {
    return (
      <div className={s.scroll} data-screen={PAGE_WORDS[whose.kind].screen}>
        <div className={s.column}>
          <PageHead title="Vault" />
          <Text tone="quiet">This hub has no vault yet. It comes with fleetd&apos;s Bun build: an owner updates the hub with fleetd update.</Text>
        </div>
      </div>
    );
  }
  return <VaultList whose={whose} />;
}

function VaultList({ whose }: { whose: Whose }) {
  const live = useLive();
  const projectName = useProjectName();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [trash, setTrash] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState<Adding | null>(null);
  const list = useToolQuery("vault_list", listInput(whose, trash), { enabled: live, keepPrevious: true });
  const status = useToolQuery("vault_status", {}, { enabled: live });
  const words = PAGE_WORDS[whose.kind];
  const items = shownItems((list.data?.items ?? []).filter((i) => onPage(whose, i)), filter, query);
  const opened = items.find((i) => i.itemId === open) ?? null;
  const ref = useReveal<HTMLDivElement>("vault.import");

  // The open item is its own group above the list, brought into view when a row opens it.
  const openRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (opened !== null) openRef.current?.scrollIntoView({ block: "nearest" });
  }, [opened?.itemId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={s.scroll} data-screen={words.screen}>
      <div className={s.column}>
        <PageHead title="Vault" />
        {status.data === undefined ? null : <StatusNote status={status.data} whose={whose} />}
        <div className={v.bar} ref={ref}>
          <Input className={v.search} type="search" aria-label="Search the vault" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
          <Segmented label="Kind" options={whose.kind === "hub" ? FILTERS.filter((f) => f.value !== "env") : FILTERS} value={filter} onChange={setFilter} />
          <AddMenu whose={whose} live={live} onPick={setAdding} />
        </div>
        {opened === null ? null : (
          <div ref={openRef}>
            <VaultItemPanel key={opened.itemId} listed={opened} whose={whose} onGone={() => setOpen(null)} onClose={() => setOpen(null)} />
          </div>
        )}
        <SettingsSection title={trash ? "Trash" : undefined}>
          {!live ? (
            <GroupNote>Not connected. Connect to a hub to see its vault.</GroupNote>
          ) : list.isLoadingError ? (
            <SettingsRow
              title="Couldn't read the vault"
              line={vaultError(list.error)}
              lineTone="danger"
              control={<Button onClick={() => void list.refetch()}>Try again</Button>}
            />
          ) : list.data === undefined ? (
            <GroupNote>Loading…</GroupNote>
          ) : (
            <SettingsList label={trash ? "Trash" : "Vault items"}>
              {items.length === 0 ? <GroupNote>{emptyLine(trash, query, filter, whose)}</GroupNote> : null}
              {items.map((item) => (
                <Row key={item.itemId} item={item} tag={scopeTag(item, projectName)} current={item.itemId === open} onOpen={() => setOpen(item.itemId === open ? null : item.itemId)} />
              ))}
              <SettingsListRow
                name={trash ? "Back to the vault" : "Trash"}
                label={trash ? "Back to the vault" : "Trash"}
                icon={trash ? <ArrowLeft /> : <Trash2 />}
                hint={trash ? undefined : "Deleted items, kept for 30 days."}
                open={{ onClick: () => (setTrash((t) => !t), setOpen(null)) }}
              />
            </SettingsList>
          )}
        </SettingsSection>
        {whose.kind === "hub" && status.data !== undefined ? <KeyPart status={status.data} /> : null}
      </div>
      {adding?.kind === "item" ? <VaultEditor whose={whose} kind={adding.item} onClose={() => setAdding(null)} onSaved={(item) => (setAdding(null), setTrash(false), setOpen(item.itemId))} /> : null}
      {adding?.kind === "paste" ? <PasteEnvDialog whose={whose} onClose={() => setAdding(null)} /> : null}
      {adding?.kind === "import" ? <ImportDialog whose={whose} onClose={() => setAdding(null)} /> : null}
    </div>
  );
}

const emptyLine = (trash: boolean, query: string, filter: Filter, whose: Whose): string =>
  trash
    ? "The trash is empty. Deleted items stay here for 30 days."
    : query.trim() !== ""
      ? "Nothing matches."
      : filter !== "all"
        ? `No ${kindWords(filter).plural.toLowerCase()} yet.`
        : whose.kind === "hub"
          ? "Nothing here yet. Add a login, a card or an address with +."
          : "Nothing here yet. Add a login, a card, an address or a variable with +.";

function Row({ item, tag, current, onOpen }: { item: VaultItemSummary; tag: string | undefined; current: boolean; onOpen: () => void }) {
  return (
    <SettingsListRow
      name={item.kind === "env" ? <span className={v.mono}>{titleOf(item)}</span> : titleOf(item)}
      label={titleOf(item)}
      icon={KIND_ICON[item.kind]}
      meta={tag}
      {...(current ? { state: { word: "open", tone: "quiet" as const } } : {})}
      open={{ onClick: onOpen }}
      data={{ "data-vault-row": item.itemId }}
    >
      <Text size="sm" tone="quiet">
        {rowLine(item) || "Empty"}
      </Text>
    </SettingsListRow>
  );
}

/** The plus menu: each kind the page takes, a pasted .env where variables go, and an import from 1Password. */
function AddMenu({ whose, live, onPick }: { whose: Whose; live: boolean; onPick: (a: Adding) => void }) {
  // The hub's items are for every project's fills: a variable is always a person's, a project's or an order's.
  const kinds: VaultKind[] = whose.kind === "hub" ? ["login", "card", "address"] : ["login", "card", "address", "env"];
  return (
    <Menu>
      <MenuTrigger asChild disabled={!live}>
        <AddButton label={live ? "Add to the vault" : "Add to the vault (connect to the hub first)"} disabled={!live} />
      </MenuTrigger>
      <MenuContent align="end">
        {kinds.map((k) => (
          <MenuItem key={k} icon={KIND_ICON[k]} onSelect={() => onPick({ kind: "item", item: k })}>
            {kindWords(k).one}
          </MenuItem>
        ))}
        <MenuSeparator />
        {whose.kind === "hub" ? null : <MenuItem onSelect={() => onPick({ kind: "paste" })}>Paste .env…</MenuItem>}
        <MenuItem onSelect={() => onPick({ kind: "import" })}>Import from 1Password…</MenuItem>
      </MenuContent>
    </Menu>
  );
}

/** A vault that can't be used now, said at the top: locked after a restart, or its key missing. */
function StatusNote({ status, whose }: { status: VaultStatusOutput; whose: Whose }) {
  const administers = useAdministers();
  const [unlocking, setUnlocking] = useState(false);
  if (status.keyMissing) {
    return (
      <div role="alert">
        <SettingsSection>
          <SettingsRow
            title="The vault's key is missing"
            lineTone="danger"
            line="No item can be filled or shown. An owner restores it on the hub with fleetd vault restore-key and the recovery code."
          />
        </SettingsSection>
      </div>
    );
  }
  if (!status.locked) return null;
  return (
    <div role="alert">
      <SettingsSection>
        <SettingsRow
          title="The vault is locked"
          lineTone="warning"
          line={
            administers
              ? "Since the hub restarted, agents can't fill anything until you unlock it. Variables already given keep working."
              : "Since the hub restarted, agents can't fill anything until an owner or admin unlocks it."
          }
          control={
            administers && whose.kind !== "project" ? (
              <Button size="sm" variant="secondary" onClick={() => setUnlocking(true)}>
                Unlock…
              </Button>
            ) : undefined
          }
        />
      </SettingsSection>
      {unlocking ? <UnlockDialog onClose={() => setUnlocking(false)} /> : null}
    </div>
  );
}

/** The passphrase, which main seals to the hub's own key on its way. */
function UnlockDialog({ onClose }: { onClose: () => void }) {
  const { hub } = useDataLayer();
  const refetch = useRefetch();
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const unlock = () => {
    setBusy(true);
    setProblem(null);
    void window.fleetd.vault.unlock(hub, { passphrase: pass }).then((out) => {
      setBusy(false);
      if (!out.ok) return setProblem(vaultErrorWords(out.error) ?? out.error.message);
      setPass("");
      refetch([...VAULT_READS]);
      toast({ title: "The vault is unlocked", tone: "success" });
      onClose();
    });
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      title="Unlock the vault"
      description="The passphrase set with fleetd vault key --store passphrase. It's sealed to the hub on its way."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={pass === "" || busy} onClick={unlock}>
            {busy ? "Unlocking…" : "Unlock"}
          </Button>
        </>
      }
    >
      <Field label="Passphrase" error={problem ?? undefined}>
        <Input type="password" autoFocus value={pass} onChange={(e) => setPass(e.target.value)} onKeyDown={(e) => (e.key === "Enter" && pass !== "" ? unlock() : undefined)} />
      </Field>
    </Dialog>
  );
}

const KEY_WHERE: Readonly<Record<string, string>> = {
  file: "a file on the hub, outside its database",
  keyring: "the hub's keychain",
  passphrase: "a passphrase, typed after each restart",
};

/** Hub › Every project › Vault's foot: where the root key is, the recovery code, Rotate, and how moving the variables in goes. */
function KeyPart({ status }: { status: VaultStatusOutput }) {
  const call = useHubCall();
  const refetch = useRefetch();
  const [rotating, setRotating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const waiting = status.migration.machines.filter((m) => m.waiting > 0);
  const rotate = () => {
    setBusy(true);
    setProblem(null);
    call("vault_rotate", {}).then(
      (out) => {
        setBusy(false);
        setRotating(false);
        refetch([...VAULT_READS]);
        toast({ title: "The vault key is rotated", description: `${String(out.rewrapped)} ${out.rewrapped === 1 ? "item" : "items"} sealed under the new key.`, tone: "success" });
      },
      (e: unknown) => {
        setBusy(false);
        setProblem(vaultError(e));
      },
    );
  };
  return (
    <SettingsSection title="Vault key" reveal="vault.key">
      <SettingsRow title="Kept in" line={`${KEY_WHERE[status.keyMode] ?? status.keyMode}${status.keyId === undefined ? "" : ` (${status.keyId})`}.`} />
      <SettingsRow
        title="Recovery code"
        lineTone={status.recoverySaved ? "quiet" : "warning"}
        line={
          status.recoverySaved ? (
            "Saved."
          ) : (
            <>
              {"Not saved yet: run "}
              <InlineCode>fleetd vault recovery-code</InlineCode>
              {" on the hub and keep it somewhere safe. Without the key or the code, every card and login is lost."}
            </>
          )
        }
      />
      {waiting.length === 0 ? null : (
        <SettingsRow
          title="Still moving in"
          hint="Items sealed on a machine before the vault, on their way in. They keep working where they are meanwhile."
          line={`${waiting.map((m) => `${String(m.waiting)} on ${m.machineId}${m.waitingFor === undefined ? "" : ` (${m.waitingFor})`}`).join(", ")}.`}
        />
      )}
      <SettingsRow
        title="Rotate the key"
        hint="Seals every item again under a new key: after an admin leaves, or if the key file may have been copied."
        line={status.locked ? "Unlock the vault to rotate its key." : status.keyMissing ? "Restore the key to rotate it." : null}
        control={
          <Button size="sm" variant="secondary" disabled={status.locked || status.keyMissing} onClick={() => setRotating(true)}>
            Rotate…
          </Button>
        }
      />
      {rotating ? (
        <Dialog
          open
          onOpenChange={(o) => (o ? undefined : setRotating(false))}
          title="Rotate the vault key?"
          description="Every item is sealed again under a new key, and the old one is dropped. Do this after an admin leaves, or if the key file may have been copied. It doesn't undo a leak: change those secrets where they come from."
          footer={
            <>
              <Button variant="secondary" onClick={() => setRotating(false)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy} onClick={rotate}>
                {busy ? "Rotating…" : "Rotate"}
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
      ) : null}
    </SettingsSection>
  );
}

/** Settings › You › Vault. */
export const YourVault = () => <VaultPage whose={{ kind: "mine" }} />;

/** A project's Vault tab, of the project its pages show. */
export function ProjectVault({ project }: { project: string | null }) {
  const slash = project?.indexOf("/") ?? -1;
  if (project === null || slash < 0) {
    return (
      <div className={s.scroll} data-screen="settings.project-vault">
        <div className={s.column}>
          <PageHead title="Vault" />
          <Text tone="quiet">No project yet.</Text>
          <Button size="sm" onClick={() => navigate({ id: "projects.add" })}>
            New project
          </Button>
        </div>
      </div>
    );
  }
  return <VaultPage key={project} whose={{ kind: "project", machineId: project.slice(0, slash), projectId: project.slice(slash + 1) }} />;
}

/** Hub › Every project › Vault. */
export const HubVault = () => <VaultPage whose={{ kind: "hub" }} />;
