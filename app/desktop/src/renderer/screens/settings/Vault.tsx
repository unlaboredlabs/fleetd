// Settings › Vault, a project's Vault tab and Hub › Every project › Vault (vault-design §8, D492). The Vault page holds
// the team's logins, cards and addresses, which everyone on the hub lists and every project's agents fill without
// seeing them, as Passwords lays them out: a search field and a filter by kind above the list, the open item above it
// (VaultItem.tsx), one plus menu to add each kind or import from 1Password (VaultForms.tsx), the trash under the list,
// and under that the items set aside for this person, only when there are some. A project's Vault tab holds its
// variables and its orders', with a plus for a variable or a pasted .env. Hub › Every project › Vault is the vault
// key alone. The lists hold metadata alone (vault_list): a value reaches this page only when the person reveals it,
// and leaves it on a timer or as soon as the window loses focus.
import { ArrowLeft, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { VaultItemSummary, VaultKind, VaultStatusOutput } from "../../../shared/contracts";
import { Button, Dialog, Field, InlineCode, Input, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Segmented, Select, Text, toast } from "../../ui";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { useAdministers } from "../admin/role";
import { navigate } from "../shell/navigation";
import { useHubCall, useLive, useRefetch } from "./hub";
import { AddButton, DangerButton, GroupNote, PageHead, SettingsList, SettingsListRow, SettingsRow, SettingsSection, useProjects } from "./parts";
import { useReveal } from "./reveal";
import { DeleteDialog, VaultItemPanel } from "./VaultItem";
import { KIND_ICON, useMoveSetAside, VAULT_READS, vaultError } from "./vaultParts";
import { ImportDialog, PasteEnvDialog, VaultEditor } from "./VaultForms";
import {
  FILTERS,
  isSetAside,
  kindWords,
  listInput,
  onPage,
  orderTag,
  pageKinds,
  rowLine,
  shownItems,
  teamServed,
  titleOf,
  vaultErrorWords,
  vaultServed,
  type Filter,
  type Whose,
} from "./vaultModel";
import s from "./settings.module.css";
import v from "./vault.module.css";

/** What the plus menu opened. */
type Adding = { readonly kind: "item"; readonly item: VaultKind } | { readonly kind: "paste" } | { readonly kind: "import" };

const SCREEN: Readonly<Record<Whose["kind"], string>> = { team: "settings.vault", project: "settings.project-vault" };

/** The page an older hub shows in place of the vault. */
function NoVault({ screen }: { screen: string }) {
  return (
    <div className={s.scroll} data-screen={screen}>
      <div className={s.column}>
        <PageHead title="Vault" />
        <Text tone="quiet">This hub has no vault yet. It comes with fleetd&apos;s Bun build: an owner updates the hub with fleetd update.</Text>
      </div>
    </div>
  );
}

export function VaultPage({ whose }: { whose: Whose }) {
  const served = useData((st) => vaultServed(st.features));
  return served ? <VaultList whose={whose} /> : <NoVault screen={SCREEN[whose.kind]} />;
}

function VaultList({ whose }: { whose: Whose }) {
  const live = useLive();
  const team = useData((st) => teamServed(st.features));
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [trash, setTrash] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState<Adding | null>(null);
  const list = useToolQuery("vault_list", listInput(whose, trash), { enabled: live, keepPrevious: true });
  const status = useToolQuery("vault_status", {}, { enabled: live });
  const listed = list.data?.items ?? [];
  const items = shownItems(
    listed.filter((i) => onPage(whose, i, team)),
    filter,
    query,
  );
  const setAside = whose.kind === "team" && !trash ? listed.filter((i) => isSetAside(i, team)) : [];
  const opened = items.find((i) => i.itemId === open) ?? null;
  const ref = useReveal<HTMLDivElement>("vault.import");

  // The open item is its own group above the list, brought into view when a row opens it.
  const openRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (opened !== null) openRef.current?.scrollIntoView({ block: "nearest" });
  }, [opened?.itemId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={s.scroll} data-screen={SCREEN[whose.kind]}>
      <div className={s.column}>
        <PageHead title="Vault" />
        {status.data === undefined ? null : <StatusNote status={status.data} whose={whose} />}
        <div className={v.bar} ref={ref}>
          <Input className={v.search} type="search" aria-label="Search the vault" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
          {whose.kind === "team" ? <Segmented label="Kind" options={FILTERS} value={filter} onChange={setFilter} /> : null}
          <AddMenu whose={whose} live={live} onPick={setAdding} />
        </div>
        {opened === null ? null : (
          <div ref={openRef}>
            <VaultItemPanel key={opened.itemId} listed={opened} onGone={() => setOpen(null)} onClose={() => setOpen(null)} />
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
                <Row key={item.itemId} item={item} tag={orderTag(item)} current={item.itemId === open} onOpen={() => setOpen(item.itemId === open ? null : item.itemId)} />
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
        {setAside.length === 0 ? null : <SetAsidePart items={setAside} />}
      </div>
      {adding?.kind === "item" ? <VaultEditor whose={whose} kind={adding.item} onClose={() => setAdding(null)} onSaved={(item) => (setAdding(null), setTrash(false), setOpen(item.itemId))} /> : null}
      {adding?.kind === "paste" ? <PasteEnvDialog whose={whose} onClose={() => setAdding(null)} /> : null}
      {adding?.kind === "import" ? <ImportDialog onClose={() => setAdding(null)} /> : null}
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
        : whose.kind === "project"
          ? "No variables yet. Add one with +."
          : "Nothing here yet. Add a login, a card or an address with +.";

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

/** The plus menu: each kind the page takes; a pasted .env on a project's, an import from 1Password on the team's. */
function AddMenu({ whose, live, onPick }: { whose: Whose; live: boolean; onPick: (a: Adding) => void }) {
  return (
    <Menu>
      <MenuTrigger asChild disabled={!live}>
        <AddButton label={live ? "Add to the vault" : "Add to the vault (connect to the hub first)"} disabled={!live} />
      </MenuTrigger>
      <MenuContent align="end">
        {pageKinds(whose).map((k) => (
          <MenuItem key={k} icon={KIND_ICON[k]} onSelect={() => onPick({ kind: "item", item: k })}>
            {kindWords(k).one}
          </MenuItem>
        ))}
        <MenuSeparator />
        {whose.kind === "project" ? (
          <MenuItem onSelect={() => onPick({ kind: "paste" })}>Paste .env…</MenuItem>
        ) : (
          <MenuItem onSelect={() => onPick({ kind: "import" })}>Import from 1Password…</MenuItem>
        )}
      </MenuContent>
    </Menu>
  );
}

/**
 * The person's own items from before the team vault that they never shared, on a hub with several people: nothing
 * uses them until they move one to the team vault (a variable, to a project they pick) or delete it.
 */
function SetAsidePart({ items }: { items: readonly VaultItemSummary[] }) {
  const move = useMoveSetAside();
  const refetch = useRefetch();
  const [picking, setPicking] = useState<VaultItemSummary | null>(null);
  const [deleting, setDeleting] = useState<VaultItemSummary | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const toTeam = (item: VaultItemSummary) => {
    setProblem(null);
    move({ itemId: item.itemId }).then(
      () => {
        refetch([...VAULT_READS]);
        toast({ title: `Moved ${titleOf(item)} to the team vault` });
      },
      (e: unknown) => setProblem(vaultError(e)),
    );
  };
  return (
    <SettingsSection title="Set aside" intro="Yours from before the team vault. Nothing uses them until you move them." data={{ "data-vault-set-aside": "" }}>
      <SettingsList label="Set aside">
        {shownItems(items, "all", "").map((item) => (
          <SettingsListRow
            key={item.itemId}
            name={item.kind === "env" ? <span className={v.mono}>{titleOf(item)}</span> : titleOf(item)}
            label={titleOf(item)}
            icon={KIND_ICON[item.kind]}
            data={{ "data-vault-row": item.itemId }}
            controls={
              <>
                {item.kind === "env" ? (
                  <Button size="sm" variant="secondary" onClick={() => setPicking(item)}>
                    Add to a project…
                  </Button>
                ) : (
                  <Button size="sm" variant="secondary" onClick={() => toTeam(item)}>
                    Move to team vault
                  </Button>
                )}
                <DangerButton size="sm" onClick={() => setDeleting(item)}>
                  Delete
                </DangerButton>
              </>
            }
          >
            <Text size="sm" tone="quiet">
              {rowLine(item) || "Empty"}
            </Text>
          </SettingsListRow>
        ))}
      </SettingsList>
      {problem === null ? null : (
        <div role="alert">
          <GroupNote tone="danger">{problem}</GroupNote>
        </div>
      )}
      {picking === null ? null : <ToProjectDialog item={picking} onClose={() => setPicking(null)} />}
      {deleting === null ? null : <DeleteDialog item={deleting} onClose={() => setDeleting(null)} onDeleted={() => setDeleting(null)} />}
    </SettingsSection>
  );
}

/** A set-aside variable made a project's, with the project picked here. */
function ToProjectDialog({ item, onClose }: { item: VaultItemSummary; onClose: () => void }) {
  const projects = useProjects();
  const move = useMoveSetAside();
  const refetch = useRefetch();
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const target = projects?.find((p) => `${p.machineId}/${p.projectId}` === picked);
  const save = () => {
    if (target === undefined) return;
    setBusy(true);
    setProblem(null);
    move({ itemId: item.itemId, machineId: target.machineId, projectId: target.projectId }).then(
      () => {
        refetch([...VAULT_READS]);
        toast({ title: `Added ${titleOf(item)} to ${target.title}`, description: "Its agents get it from their next start." });
        onClose();
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
      title={`Add ${titleOf(item)} to a project`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || target === undefined} onClick={save}>
            {busy ? "Adding…" : "Add"}
          </Button>
        </>
      }
    >
      {projects === undefined ? (
        <Text size="sm" tone="quiet">
          Loading the projects…
        </Text>
      ) : projects.length === 0 ? (
        <Text size="sm" tone="quiet">
          No projects yet.
        </Text>
      ) : (
        <Select
          aria-label="Project"
          placeholder="Pick a project"
          value={picked}
          options={projects.map((p) => ({ value: `${p.machineId}/${p.projectId}`, label: p.title }))}
          onValueChange={setPicked}
        />
      )}
      {problem === null ? null : (
        <div role="alert">
          <Text size="sm" tone="danger">
            {problem}
          </Text>
        </div>
      )}
    </Dialog>
  );
}

/** A vault that can't be used now, said at the top: locked after a restart, or its key missing. */
function StatusNote({ status, whose }: { status: VaultStatusOutput; whose: Whose | "key" }) {
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
            administers && (whose === "key" || whose.kind !== "project") ? (
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

/** Hub › Every project › Vault: where the root key is, the recovery code, Rotate, and how moving the variables in goes. */
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

/** Settings › Vault: the team's logins, cards and addresses. */
export const TeamVault = () => <VaultPage whose={{ kind: "team" }} />;

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

/** Hub › Every project › Vault: the vault key, and the vault's state when it can't be used. */
export function HubVault() {
  const served = useData((st) => vaultServed(st.features));
  const live = useLive();
  const status = useToolQuery("vault_status", {}, { enabled: live && served });
  if (!served) return <NoVault screen="settings.hub.vault" />;
  return (
    <div className={s.scroll} data-screen="settings.hub.vault">
      <div className={s.column}>
        <PageHead title="Vault" />
        {!live ? (
          <GroupNote>Not connected. Connect to a hub to see its vault.</GroupNote>
        ) : status.isLoadingError ? (
          <Text tone="danger">{vaultError(status.error)}</Text>
        ) : status.data === undefined ? (
          <GroupNote>Loading…</GroupNote>
        ) : (
          <>
            <StatusNote status={status.data} whose="key" />
            <KeyPart status={status.data} />
          </>
        )}
      </div>
    </div>
  );
}
