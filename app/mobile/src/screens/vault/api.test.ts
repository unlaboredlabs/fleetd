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

const { deleteItem, dismissImport, importItems, listItems, moveItem, reveal, saveItem, sealToHub, searchOnePassword, usableCards, vaultErrorWords } = await import("./api");
const { openSealed, seal, toBase64, fromBase64, utf8, utf8Encode, keyPairOf } = await import("../../seal");

const HUB = keyPairOf(new Uint8Array(randomBytes(32)));
const STATUS = { hubBoxKey: toBase64(HUB.publicKey), locked: false };
const SUMMARY = { itemId: "V1", kind: "card", scope: "hub", label: "Visa", meta: { brand: "visa", last4: "4242" }, createdMs: 1, updatedMs: 1, updatedBy: "human:phone", version: 1, canEdit: true, canReveal: true };

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
    const r = await saveItem(hub, { kind: "card", label: "Visa", fields });
    expect(r).toEqual({ ok: true, value: SUMMARY });
    const save = calls.find((c) => c.tool === "vault_save")!;
    expect(save.input).toEqual({ kind: "card", label: "Visa", sealed: expect.any(String) });
    expect(JSON.stringify(save.input)).not.toContain("4242424242424242");
    expect(opened(save.input.sealed as string)).toEqual(fields);
  });

  it("changes only the label without asking for the hub's key or sealing anything", async () => {
    const { hub, calls } = fake({ vault_save: () => ({ item: SUMMARY }) });
    await saveItem(hub, { itemId: "V1", kind: "login", label: "Amazon", sites: ["amazon.com"], fields: {} });
    expect(calls).toEqual([{ tool: "vault_save", input: { itemId: "V1", kind: "login", label: "Amazon", sites: ["amazon.com"] }, timeoutMs: undefined }]);
  });

  it("seals a cleared field as empty, which the hub's merge takes away", async () => {
    const { hub, calls } = fake({ vault_status: () => STATUS, vault_save: () => ({ item: SUMMARY }) });
    await saveItem(hub, { itemId: "V1", kind: "address", label: "Home", sites: [], fields: { line2: "" } });
    expect(opened(calls.find((c) => c.tool === "vault_save")!.input.sealed as string)).toEqual({ line2: "" });
  });

  it("puts a new variable in its project, its name and secrecy beside it", async () => {
    const { hub, calls } = fake({ vault_status: () => STATUS, vault_save: () => ({ item: SUMMARY }) });
    await saveItem(hub, { kind: "env", project: { machineId: "devbox", projectId: "p1", title: "x" } as never, label: "K", envName: "K", secret: false, fields: { value: "v" } });
    expect(calls.at(-1)!.input).toEqual({ kind: "env", scope: "project", machineId: "devbox", projectId: "p1", label: "K", envName: "K", secret: false, sealed: expect.any(String) });
  });

  it("names no scope for a login, card or address, nor for a change: never the person's own or the hub's", async () => {
    const { hub, calls } = fake({ vault_status: () => STATUS, vault_save: () => ({ item: SUMMARY }) });
    const p1 = { machineId: "devbox", projectId: "p1" };
    // A card added from a project's Payments goes to the team vault too.
    await saveItem(hub, { kind: "card", project: p1, label: "Visa", fields: { number: "4242424242424242" } });
    await saveItem(hub, { kind: "login", label: "Shop", sites: ["shop.example"], fields: { password: "p" } });
    await saveItem(hub, { itemId: "V2", kind: "env", project: p1, label: "K", fields: { value: "w" } });
    const saves = calls.filter((c) => c.tool === "vault_save").map((c) => c.input);
    expect(saves).toHaveLength(3);
    for (const s of saves) {
      expect(s).not.toHaveProperty("scope");
      expect(s).not.toHaveProperty("projectId");
    }
  });

  it("says to update the app when a newer hub refuses an older one's scope", () => {
    expect(vaultErrorWords({ code: "invalid", message: "This app is older than the hub: update it to add vault items.", reason: "vault_update_app" })).toMatch(/Update it/u);
  });

  it("refuses while the vault is locked, before anything is sealed", async () => {
    const { hub, calls } = fake({ vault_status: () => ({ ...STATUS, locked: true }) });
    const r = await saveItem(hub, { kind: "login", label: "x", fields: { password: "p" } });
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

  const own = { ...SUMMARY, itemId: "V2", scope: "project", kind: "env" };
  const order = { ...SUMMARY, itemId: "V3", scope: "order", kind: "env" };
  const mine = { ...SUMMARY, itemId: "V5", scope: "person", kind: "login" };
  const newer = { ...SUMMARY, itemId: "V4", kind: "passport" };

  it("lists the team vault, with the person's set-aside items apart", async () => {
    const { hub, calls } = fake({ vault_list: () => ({ items: [SUMMARY, mine, newer] }) });
    expect(await listItems(hub, { kind: "team" }, true)).toEqual({ ok: true, value: { items: [SUMMARY], setAside: [mine] } });
    expect(calls.map((c) => c.input)).toEqual([{}]);
  });

  it("sets nothing aside when there's nothing to set aside", async () => {
    const { hub } = fake({ vault_list: () => ({ items: [SUMMARY] }) });
    expect(await listItems(hub, { kind: "team" }, true)).toEqual({ ok: true, value: { items: [SUMMARY], setAside: [] } });
  });

  it("lists an older hub's own and hub items as one list, its projects' left to them", async () => {
    const { hub } = fake({ vault_list: () => ({ items: [SUMMARY, mine, own, order, newer] }) });
    expect(await listItems(hub, { kind: "team" }, false)).toEqual({ ok: true, value: { items: [SUMMARY, mine], setAside: [] } });
  });

  it("lists a project's variables and its orders'", async () => {
    const { hub, calls } = fake({ vault_list: () => ({ items: [own, order, newer] }) });
    expect(await listItems(hub, { kind: "project", project: { machineId: "devbox", projectId: "p1" } }, true)).toEqual({ ok: true, value: { items: [own, order], setAside: [] } });
    expect(calls.map((c) => c.input)).toEqual([{ machineId: "devbox", projectId: "p1" }]);
  });

  it("moves a set-aside item to the team vault, or a variable to a project", async () => {
    const { hub, calls } = fake({ vault_move: (input) => ({ item: { ...SUMMARY, itemId: input.itemId, scope: input.projectId === undefined ? "hub" : "project" } }) });
    expect(await moveItem(hub, "V5")).toMatchObject({ ok: true, value: { itemId: "V5", scope: "hub" } });
    expect(await moveItem(hub, "V6", { machineId: "devbox", projectId: "p1", title: "Nova" } as never)).toMatchObject({ ok: true, value: { scope: "project" } });
    expect(calls.map((c) => c.input)).toEqual([{ itemId: "V5" }, { itemId: "V6", machineId: "devbox", projectId: "p1" }]);
  });

  it("deletes to the trash, imports what was ticked, and dismisses a proposal", async () => {
    const { hub, calls } = fake({ vault_delete: () => ({}), vault_import: () => ({ items: [SUMMARY], errors: [] }) });
    expect(await deleteItem(hub, "V1")).toEqual({ ok: true, value: null });
    expect(await importItems(hub, { proposalId: "P1", refs: ["op://v/a"] })).toEqual({ ok: true, value: { items: [SUMMARY], errors: [] } });
    expect(await importItems(hub, { refs: ["op://v/b"] })).toEqual({ ok: true, value: { items: [SUMMARY], errors: [] } });
    expect(await dismissImport(hub, "P1")).toEqual({ ok: true, value: null });
    expect(calls.map((c) => [c.tool, c.input])).toEqual([
      ["vault_delete", { itemId: "V1" }],
      ["vault_import", { proposalId: "P1", refs: ["op://v/a"] }],
      ["vault_import", { refs: ["op://v/b"] }],
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
