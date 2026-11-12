// The Vault's forms, each a dialog: add or edit an item (VaultEditor), paste a .env (PasteEnvDialog), and import from
// 1Password (ImportDialog: search, tick, Import). What the person types goes to main, which seals it to the hub's own
// key (main/vault.ts); an edit never shows the stored values, and a sealed field left empty stays as it is. An import
// is read on a machine holding the person's 1Password token and sealed to the hub there, so no value crosses this app.
import { useState } from "react";
import type { VaultImportCandidate, VaultItemSummary, VaultKind } from "../../../shared/contracts";
import type { VaultSaveRequest } from "../../../shared/ipc";
import { Button, Checkbox, Dialog, Field, Input, Segmented, Switch, Text, Textarea, toast } from "../../ui";
import { useDataLayer, useToolQuery } from "../../src/data/react";
import { PROJECT_TOOLS } from "../projects/model";
import { navigate } from "../shell/navigation";
import { useHubCall, useRefetch } from "./hub";
import { parseDotEnv, withKind, type EnvKind } from "./projectModel";
import { VAULT_READS, vaultError } from "./vaultParts";
import { brandName, brandOf, check, clearable, draftOf, emptyDraft, fieldsOf, kindWords, placeOf, titleOf, vaultErrorWords, type Draft, type Whose } from "./vaultModel";
import s from "./settings.module.css";
import v from "./vault.module.css";

/** Searching 1Password and reading items from it may install its SDK on a machine first. */
const ONEPASSWORD_MS = 240_000;

/** A sealed field's input: a password-style one for what's masked. */
function SecretInput(props: {
  label: string;
  value: string;
  masked: boolean;
  editing: boolean;
  mono?: boolean;
  multiline?: boolean;
  placeholder?: string;
  onChange: (v: string) => void;
  /** On an edit, a field the item has that may be emptied: Clear marks it, and saving drops it. */
  clear?: { readonly cleared: boolean; readonly onToggle: () => void } | undefined;
}) {
  const cleared = props.clear?.cleared === true;
  const placeholder = cleared ? "Cleared when you save" : props.editing ? "Unchanged" : props.placeholder;
  const input =
    props.multiline === true ? (
      <Textarea mono={props.mono === true} value={props.value} disabled={cleared} minRows={2} maxRows={10} placeholder={placeholder} onChange={(e) => props.onChange(e.target.value)} />
    ) : (
      <Input
        type={props.masked ? "password" : "text"}
        mono={props.mono === true}
        autoComplete="off"
        spellCheck={false}
        value={props.value}
        disabled={cleared}
        placeholder={placeholder}
        onChange={(e) => props.onChange(e.target.value)}
      />
    );
  return (
    <Field label={props.label}>
      {props.clear === undefined ? (
        input
      ) : (
        <div className={v.bar}>
          <div className={v.search}>{input}</div>
          <Button size="sm" variant="ghost" aria-label={`${cleared ? "Keep" : "Clear"} the ${props.label.toLowerCase()}`} onClick={props.clear.onToggle}>
            {cleared ? "Keep" : "Clear"}
          </Button>
        </div>
      )}
    </Field>
  );
}

/** Add an item of `kind` to the page `whose` (the team's when absent), or edit `item` without revealing it. */
export function VaultEditor({ whose = { kind: "team" }, kind, item, onClose, onSaved }: { whose?: Whose; kind: VaultKind; item?: VaultItemSummary; onClose: () => void; onSaved: (item: VaultItemSummary) => void }) {
  const { hub } = useDataLayer();
  const refetch = useRefetch();
  const editing = item !== undefined;
  const [draft, setDraft] = useState<Draft>(() => (item === undefined ? emptyDraft(kind) : draftOf(item)));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const set = (k: string) => (value: string) => setDraft((d) => ({ ...d, fields: { ...d.fields, [k]: value } }));
  // A field the item has, and may lose: Clear drops it on save, Keep takes that back (and so does typing a new value).
  const has = (k: string) => item === undefined || item.meta.fields === undefined || (item.meta.fields as readonly string[]).includes(k);
  const clearOf = (k: string) =>
    editing && clearable(kind, k) && has(k)
      ? {
          cleared: draft.cleared.includes(k),
          onToggle: () =>
            setDraft((d) => ({
              ...d,
              cleared: d.cleared.includes(k) ? d.cleared.filter((c) => c !== k) : [...d.cleared, k],
              fields: { ...d.fields, [k]: "" },
            })),
        }
      : undefined;
  const f = (k: string) => draft.fields[k] ?? "";
  const words = kindWords(kind);

  const save = () => {
    const checked = check(draft, editing, new Date());
    if (!checked.ok) return setProblem(checked.problem);
    setBusy(true);
    setProblem(null);
    const c = checked.value;
    void window.fleetd.vault
      .save(hub, {
        ...(item === undefined ? { kind: kind as VaultSaveRequest["kind"], ...placeOf(whose) } : { itemId: item.itemId }),
        label: c.label,
        ...(kind === "login" || kind === "address" ? { sites: [...c.sites] } : {}),
        ...(c.envName === undefined ? {} : { envName: c.envName }),
        ...(c.secret === undefined ? {} : { secret: c.secret }),
        ...(Object.keys(c.fields).length === 0 ? {} : { fields: c.fields }),
      })
      .then((out) => {
        setBusy(false);
        if (!out.ok) return setProblem(vaultErrorWords(out.error) ?? (out.error.fix ? `${out.error.message} ${out.error.fix}` : out.error.message));
        refetch([...VAULT_READS, PROJECT_TOOLS.purchases]);
        const saved = (out.output as { item: VaultItemSummary }).item;
        toast({ title: editing ? `Saved ${titleOf(saved)}` : `Added ${titleOf(saved)}`, ...(kind === "env" ? { description: "Agents get it from their next start." } : {}) });
        onSaved(saved);
      });
  };

  const brand = brandOf(f("number"));
  return (
    <Dialog
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      title={editing ? `Edit ${titleOf(item)}` : `New ${words.one.toLowerCase()}`}
      description={editing ? "Its saved values aren't shown here. Type a new one to replace it; leave a field empty to keep it." : "Sealed on this computer before it goes to the hub."}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={save}>
            {busy ? "Saving…" : editing ? "Save" : "Add"}
          </Button>
        </>
      }
    >
      <form
        className={v.form}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        {kind === "env" ? (
          <>
            <Field label="Name">
              <Input mono autoFocus={!editing} disabled={editing} value={draft.envName} placeholder="STRIPE_KEY" onChange={(e) => setDraft((d) => ({ ...d, envName: e.target.value }))} />
            </Field>
            {editing ? (
              <Text size="xs" tone="quiet">
                A variable keeps its name. To rename it, add a new one and delete this.
              </Text>
            ) : null}
            <SecretInput label="Value" mono multiline value={f("value")} masked editing={editing && draft.secret} placeholder={draft.secret ? "" : "Shown as it is"} onChange={set("value")} />
            <Switch
              label="Secret"
              description={draft.secret ? "Masked in every list and log. You can show it again behind Touch ID." : "Shown as it is, in lists too."}
              checked={draft.secret}
              onCheckedChange={(secret) => setDraft((d) => ({ ...d, secret }))}
            />
          </>
        ) : (
          <>
            <Field label="Name">
              <Input autoFocus value={draft.label} placeholder={kind === "card" ? `${brand === undefined ? "Visa" : brandName(brand)} (Personal)` : kind === "address" ? "Home" : "Amazon"} onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))} />
            </Field>
            {kind === "login" || kind === "address" ? (
              <Field
                label={kind === "login" ? "Websites" : "Websites (optional)"}
                description={kind === "login" ? "Where it signs in, one per line. A pasted address is cut to its site." : "Where else it may fill, besides checkouts and the sites the vault has logins for."}
              >
                <Textarea value={draft.sites} minRows={1} maxRows={5} placeholder="amazon.com" onChange={(e) => setDraft((d) => ({ ...d, sites: e.target.value }))} />
              </Field>
            ) : null}
            {kind === "card" ? (
              <>
                <SecretInput label="Number" mono value={f("number")} masked={false} editing={editing} placeholder="4242 4242 4242 4242" onChange={set("number")} />
                <div className={v.pair}>
                  <SecretInput label="Expires" mono value={f("expiry")} masked={false} editing={editing} placeholder="MM/YY" onChange={set("expiry")} />
                  <SecretInput label="Security code" mono value={f("cvc")} masked editing={editing} placeholder={brand === "amex" ? "4 digits" : "3 digits"} onChange={set("cvc")} clear={clearOf("cvc")} />
                </div>
                <SecretInput label="Name on card" value={f("name")} masked={false} editing={editing} onChange={set("name")} clear={clearOf("name")} />
              </>
            ) : (
              fieldsOf(kind).map((spec) => (
                  <SecretInput
                    key={spec.key}
                    label={spec.key === "country" ? "Country (two letters)" : spec.label}
                    value={f(spec.key)}
                    masked={spec.masked && !(spec.multiline === true)}
                    multiline={spec.multiline === true}
                    editing={editing}
                    placeholder={spec.key === "country" ? "DE" : spec.key === "totp" ? "otpauth://… or the base32 seed" : ""}
                    onChange={set(spec.key)}
                    clear={clearOf(spec.key)}
                  />
                ))
            )}
          </>
        )}
        {problem === null ? null : (
          <div role="alert">
            <Text size="sm" tone="danger">
              {problem}
            </Text>
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

/** A pasted .env, each variable plain or secret, saved as the project's variables. */
export function PasteEnvDialog({ whose, onClose }: { whose: Whose; onClose: () => void }) {
  const { hub } = useDataLayer();
  const refetch = useRefetch();
  const [text, setText] = useState("");
  const [kinds, setKinds] = useState<Readonly<Record<string, EnvKind>>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const vars = parseDotEnv(text).map((p) => {
    const k = kinds[p.name];
    return k === undefined || k === p.kind ? p : withKind(p, k);
  });
  const good = vars.filter((p) => p.problem === null);
  const save = async () => {
    setBusy(true);
    setProblem(null);
    let saved = 0;
    for (const p of good) {
      const out = await window.fleetd.vault.save(hub, { kind: "env", ...placeOf(whose), envName: p.name, label: p.name, secret: p.kind === "secret", fields: { value: p.value } });
      if (!out.ok) {
        setBusy(false);
        refetch([...VAULT_READS]);
        setProblem(`${p.name}: ${vaultErrorWords(out.error) ?? out.error.message}${saved > 0 ? ` (${String(saved)} saved before it)` : ""}`);
        return;
      }
      saved++;
    }
    refetch([...VAULT_READS]);
    toast({ title: `Saved ${String(saved)} ${saved === 1 ? "variable" : "variables"}`, description: "Agents get them from their next start." });
    onClose();
  };
  return (
    <Dialog
      open
      wide
      onOpenChange={(o) => (o ? undefined : onClose())}
      title="Paste a .env"
      description="Each line becomes a variable. A name that's already in the vault here gets the new value."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || good.length === 0} onClick={() => void save()}>
            {busy ? "Saving…" : good.length === 0 ? "Save" : `Save ${String(good.length)}`}
          </Button>
        </>
      }
    >
      <div className={v.form}>
        <Textarea mono aria-label=".env contents" value={text} minRows={6} maxRows={14} placeholder={"DATABASE_URL=postgres://localhost/app\nSTRIPE_KEY=sk_test_…"} onChange={(e) => setText(e.target.value)} />
        {vars.length === 0 ? null : (
          <div className={v.picks} role="list" aria-label="Variables">
            {vars.map((p) => (
              <div key={p.name} role="listitem" className={s.inline}>
                <Text mono strong size="sm">
                  {p.name}
                </Text>
                <Segmented
                  label={`${p.name} is`}
                  options={[
                    { value: "secret", label: "Secret" },
                    { value: "plain", label: "Plain" },
                  ]}
                  value={p.kind}
                  onChange={(k: EnvKind) => setKinds((was) => ({ ...was, [p.name]: k }))}
                />
                {p.problem === null ? null : (
                  <Text size="xs" tone="danger">
                    {p.problem}
                  </Text>
                )}
              </div>
            ))}
          </div>
        )}
        {problem === null ? null : (
          <div role="alert">
            <Text size="sm" tone="danger">
              {problem}
            </Text>
          </div>
        )}
      </div>
    </Dialog>
  );
}

const noInput = {};

/**
 * Import from 1Password into the team vault: search the person's 1Password (titles and sites, never values), tick,
 * Import. The items are read on a machine holding their token and sealed to the hub there; they name no place, as a
 * new item doesn't (vaultModel's placeOf). Without a token saved, it says where to add one.
 */
export function ImportDialog({ onClose }: { onClose: () => void }) {
  const token = useToolQuery("onepassword_get", noInput);
  const call = useHubCall();
  const refetch = useRefetch();
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ items: readonly VaultImportCandidate[]; error?: string } | "searching" | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const kinds: VaultKind[] = ["login", "card", "address"];

  const search = () => {
    if (query.trim() === "") return;
    setFound("searching");
    setProblem(null);
    call("vault_import_search", { query: query.trim(), kinds }, { timeoutMs: ONEPASSWORD_MS }).then(
      (out) => {
        setFound({ items: out.items, ...(out.error === undefined ? {} : { error: out.error }) });
        setPicked(new Set(out.items.filter((i) => i.imported === undefined).map((i) => i.ref)));
      },
      (e: unknown) => setFound({ items: [], error: vaultError(e) }),
    );
  };

  const importNow = () => {
    setBusy(true);
    setProblem(null);
    call("vault_import", { refs: [...picked] }, { timeoutMs: ONEPASSWORD_MS }).then(
      (out) => {
        setBusy(false);
        refetch([...VAULT_READS]);
        if (out.errors.length > 0) {
          setProblem(out.errors.map((e) => `${(found !== null && found !== "searching" ? found.items.find((i) => i.ref === e.ref)?.title : undefined) ?? e.ref}: ${e.message}`).join("\n"));
          setFound(null);
          if (out.items.length === 0) return;
        }
        toast({ title: `Imported ${String(out.items.length)} ${out.items.length === 1 ? "item" : "items"}`, description: "1Password isn't asked again for them.", tone: "success" });
        if (out.errors.length === 0) onClose();
      },
      (e: unknown) => {
        setBusy(false);
        setProblem(vaultError(e));
      },
    );
  };

  const noToken = token.data !== undefined && token.data.token === undefined;
  const results = found !== null && found !== "searching" ? found : null;
  return (
    <Dialog
      open
      wide
      onOpenChange={(o) => (o ? undefined : onClose())}
      title="Import from 1Password"
      description="Read on your machine and sealed there; no value passes through this app or any agent."
      footer={
        noToken ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => (onClose(), navigate({ id: "settings", tab: "accounts" }))}>
              Open Your accounts
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy || picked.size === 0} onClick={importNow}>
              {busy ? "Importing…" : picked.size === 0 ? "Import" : `Import ${String(picked.size)}`}
            </Button>
          </>
        )
      }
    >
      {noToken ? (
        <Text size="sm">Importing reads your 1Password with your service account token, which isn&apos;t saved yet. Add it under Settings › You › Your accounts › 1Password, then come back.</Text>
      ) : (
        <div className={v.form}>
          <form
            className={v.bar}
            onSubmit={(e) => {
              e.preventDefault();
              search();
            }}
          >
            <Input className={v.search} type="search" autoFocus aria-label="Search 1Password" placeholder="Search your 1Password" value={query} onChange={(e) => setQuery(e.target.value)} />
            <Button type="submit" disabled={query.trim() === "" || found === "searching"}>
              Search
            </Button>
          </form>
          {found === "searching" ? (
            <Text size="sm" tone="quiet">
              Searching your 1Password. The first time on a machine, this can take a few minutes.
            </Text>
          ) : results?.error !== undefined ? (
            <Text size="sm" tone="danger">{`1Password: ${results.error}`}</Text>
          ) : results !== null && results.items.length === 0 ? (
            <Text size="sm" tone="quiet">
              Nothing in your 1Password matches.
            </Text>
          ) : results !== null ? (
            <div className={v.picks} role="group" aria-label="1Password items">
              {results.items.map((i) => (
                <Checkbox
                  key={i.ref}
                  label={i.title}
                  description={[kindWords(i.kind).one, i.sites?.[0], i.vault, i.imported === undefined ? undefined : "already in the vault"].filter(Boolean).join(" · ")}
                  checked={picked.has(i.ref)}
                  onCheckedChange={(c) =>
                    setPicked((was) => {
                      const next = new Set(was);
                      if (c === true) next.add(i.ref);
                      else next.delete(i.ref);
                      return next;
                    })
                  }
                />
              ))}
            </div>
          ) : null}
          {problem === null ? null : (
            <div role="alert">
              <Text size="sm" tone="danger" preserveLines>
                {problem}
              </Text>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
