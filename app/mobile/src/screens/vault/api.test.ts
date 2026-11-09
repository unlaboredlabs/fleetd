// The vault's calls over a fake hub: what crosses is sealed, to the hub's key on the way in and to a one-time key on
// the way out, and nothing of a value is kept.
import { randomBytes } from "node:crypto";
import nacl from "tweetnacl";
import { describe, expect, it, vi } from "vitest";

/** Every key pair the code makes, to check each one-time secret key was wiped. */
const made: Uint8Array[] = [];
vi.mock("expo-crypto", () => ({
  getRandomBytes: (n: number) => {
    const bytes = new Uint8Array(randomBytes(n));
    made.push(bytes);
    return bytes;
  },
}));

const { deleteItem, dismissImport, importItems, listItems, reveal, saveItem, sealToHub, searchOnePassword, usableCards, vaultErrorWords } = await import("./api");
const { openSealed, seal, toBase64, fromBase64, utf8, utf8Encode, keyPairOf } = await import("../../seal");

const HUB = keyPairOf(new Uint8Array(randomBytes(32)));
const STATUS = { hubBoxKey: toBase64(HUB.publicKey), locked: false };
const SUMMARY = { itemId: "V1", kind: "card", scope: "person", label: "Visa", meta: { brand: "visa", last4: "4242" }, createdMs: 1, updatedMs: 1, updatedBy: "human:phone", version: 1, canEdit: true, canReveal: true };

/** A hub that answers each tool from `answers`, recording what it was called with. */
const fake = (answers: Record<string, (input: Record<string, unknown>) => unknown>) => {
  const calls: Array<{ tool: string; input: Record<string, unknown>; timeoutMs: number | undefined }> = [];
  return {
    calls,
    hub: {
      call: async (tool: string, input: unknown, timeoutMs?: number) => {
        calls.push({ tool, input: input as Record<string, unknown>, timeoutMs });
        const answer = answers[tool];
        if (answer === undefined) return { ok: false as const, error: { code: "not_found", message: `no ${tool}` } };
        const out = answer(input as Record<string, unknown>);
        return out instanceof Error ? { ok: false as const, error: { code: "failed", message: out.message, reason: out.name } } : { ok: true as const, output: out };
      },
    },
  };
};

const opened = (sealed: string): unknown => JSON.parse(utf8(openSealed(fromBase64(sealed)!, HUB)!)!);

describe("saving an item", () => {
  it("seals the typed fields to the hub's key and sends nothing of them in the clear", async () => {
    const { hub, calls } = fake({ vault_status: () => STATUS, vault_save: () => ({ item: SUMMARY }) });
    const fields = { number: "4242424242424242", month: "04", year: "28", cvc: "123" };
    const r = await saveItem(hub, { kind: "card", scope: "person", label: "Visa", fields });
    expect(r).toEqual({ ok: true, value: SUMMARY });
    const save = calls.find((c) => c.tool === "vault_save")!;
    expect(save.input).toEqual({ kind: "card", scope: "person", label: "Visa", sealed: expect.any(String) });
    expect(JSON.stringify(save.input)).not.toContain("4242424242424242");
    expect(opened(save.input.sealed as string)).toEqual(fields);
  });

  it("changes only the label without asking for the hub's key or sealing anything", async () => {
    const { hub, calls } = fake({ vault_save: () => ({ item: SUMMARY }) });
    await saveItem(hub, { itemId: "V1", kind: "login", scope: "person", label: "Amazon", sites: ["amazon.com"], fields: {} });
    expect(calls).toEqual([{ tool: "vault_save", input: { itemId: "V1", kind: "login", scope: "person", label: "Amazon", sites: ["amazon.com"] }, timeoutMs: undefined }]);
  });

  it("seals a cleared field as empty, which the hub's merge takes away", async () => {
    const { hub, calls } = fake({ vault_status: () => STATUS, vault_save: () => ({ item: SUMMARY }) });
    await saveItem(hub, { itemId: "V1", kind: "address", scope: "person", label: "Home", sites: [], fields: { line2: "" } });
    expect(opened(calls.find((c) => c.tool === "vault_save")!.input.sealed as string)).toEqual({ line2: "" });
  });

  it("puts a project's item in that project, and a variable's name and secrecy beside it", async () => {
    const { hub, calls } = fake({ vault_status: () => STATUS, vault_save: () => ({ item: SUMMARY }) });
    await saveItem(hub, { kind: "env", scope: "project", project: { machineId: "devbox", projectId: "p1", title: "x" } as never, label: "K", envName: "K", secret: false, fields: { value: "v" } });
    expect(calls.at(-1)!.input).toEqual({ kind: "env", scope: "project", machineId: "devbox", projectId: "p1", label: "K", envName: "K", secret: false, sealed: expect.any(String) });
  });

  it("refuses while the vault is locked, before anything is sealed", async () => {
    const { hub, calls } = fake({ vault_status: () => ({ ...STATUS, locked: true }) });
    const r = await saveItem(hub, { kind: "login", scope: "person", label: "x", fields: { password: "p" } });
    expect(r).toMatchObject({ ok: false, error: { message: expect.stringMatching(/locked/u) } });
    expect(calls.map((c) => c.tool)).toEqual(["vault_status"]);
  });

  it("wipes the one-time key it sealed with", () => {
    made.length = 0;
    expect(sealToHub({ a: "b" }, STATUS.hubBoxKey)).not.toBeNull();
    expect(made).toHaveLength(1);
    expect(made[0]!.every((b) => b === 0)).toBe(true);
    expect(sealToHub({ a: "b" }, "short")).toBeNull();
  });
});

describe("revealing", () => {
  it("opens fields the hub sealed to a key made for this reveal, and wipes that key", async () => {
    made.length = 0;
    const { hub, calls } = fake({
      vault_reveal: (input) => ({ sealed: toBase64(seal(utf8Encode(JSON.stringify({ password: "pässwörd ✓" })), fromBase64(input.replyKey as string)!)) }),
    });
    const r = await reveal(hub, "V1", ["password"]);
    expect(r).toEqual({ ok: true, value: { password: "pässwörd ✓" } });
    expect(calls[0]!.input).toEqual({ itemId: "V1", fields: ["password"], replyKey: expect.any(String) });
    expect(made.every((k) => k.every((b) => b === 0))).toBe(true);
  });

  it("says so when the answer isn't a box for this phone", async () => {
    const other = nacl.box.keyPair();
    const { hub } = fake({ vault_reveal: () => ({ sealed: toBase64(seal(utf8Encode("{}"), other.publicKey)) }) });
    expect(await reveal(hub, "V1", ["password"])).toMatchObject({ ok: false, error: { message: expect.stringMatching(/didn't open/u) } });
    const { hub: garbled } = fake({ vault_reveal: () => ({ sealed: "!!" }) });
    expect(await reveal(garbled, "V1", ["password"])).toMatchObject({ ok: false });
  });

  it("passes the hub's refusal on", async () => {
    const { hub } = fake({ vault_reveal: () => Object.assign(new Error("Too many."), { name: "vault_rate_limited" }) });
    const r = await reveal(hub, "V1", ["password"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(vaultErrorWords(r.error)).toMatch(/Too many reveals/u);
  });
});

describe("the rest", () => {
  it("lists the cards a project can pay with", async () => {
    const gone = { ...SUMMARY, itemId: "V9", deletedMs: 5 };
    const { hub, calls } = fake({ vault_list: () => ({ items: [SUMMARY, gone] }) });
    expect(await usableCards(hub, { machineId: "devbox", projectId: "p1" })).toEqual({ ok: true, value: [SUMMARY] });
    expect(calls[0]!.input).toEqual({ kind: "card", machineId: "devbox", projectId: "p1", usable: true });
  });

  it("lists the person's items, or a project's", async () => {
    const own = { ...SUMMARY, itemId: "V2", scope: "project" };
    const order = { ...SUMMARY, itemId: "V3", scope: "order", kind: "env" };
    const newer = { ...SUMMARY, itemId: "V4", kind: "passport" };
    const { hub, calls } = fake({ vault_list: () => ({ items: [SUMMARY, own, order, newer] }) });
    expect(await listItems(hub, { kind: "mine" })).toEqual({ ok: true, value: [SUMMARY, own, order] });
    expect(await listItems(hub, { kind: "project", project: { machineId: "devbox", projectId: "p1" } })).toEqual({ ok: true, value: [own, order] });
    expect(calls.map((c) => c.input)).toEqual([{}, { machineId: "devbox", projectId: "p1" }]);
  });

  it("deletes to the trash, imports what was ticked, and dismisses a proposal", async () => {
    const { hub, calls } = fake({ vault_delete: () => ({}), vault_import: () => ({ items: [SUMMARY], errors: [] }) });
    expect(await deleteItem(hub, "V1")).toEqual({ ok: true, value: null });
    expect(await importItems(hub, { proposalId: "P1", refs: ["op://v/a"], scope: "person" })).toEqual({ ok: true, value: { items: [SUMMARY], errors: [] } });
    expect(await dismissImport(hub, "P1")).toEqual({ ok: true, value: null });
    expect(calls.map((c) => [c.tool, c.input])).toEqual([
      ["vault_delete", { itemId: "V1" }],
      ["vault_import", { proposalId: "P1", refs: ["op://v/a"], scope: "person" }],
      ["vault_import", { proposalId: "P1", dismiss: true }],
    ]);
    expect(calls[1]!.timeoutMs).toBe(240_000);
  });
});

describe("searching 1Password", () => {
  it("lists what it found, and says 1Password's own refusal as an error", async () => {
    const hit = { ref: "op://v/a", title: "Amazon", kind: "login", sites: ["amazon.com"], vault: "fleetd" };
    const { hub } = fake({ vault_import_search: () => ({ items: [hit, { ...hit, ref: "op://v/b", kind: "passport" }] }) });
    expect(await searchOnePassword(hub, "am")).toEqual({ ok: true, value: [hit] });
    const { hub: none } = fake({ vault_import_search: () => ({ items: [], error: "No 1Password token saved." }) });
    expect(await searchOnePassword(none, "")).toMatchObject({ ok: false, error: { message: "No 1Password token saved." } });
  });
});
