// fleetd's 1Password helper: resolves op:// references with the SDK and a service account token. The token is the
// first line on stdin, not in the environment, where the user's other processes could read it.
import { createClient, RateLimitExceededError } from "@1password/sdk";
import { createInterface } from "node:readline";

let token;
// Made at the first reference, so a token 1Password refuses is said in each answer.
let client;
// The account's vaults, and each vault's items, listed once: a session's fills read 1Password as little as they can.
let vaults;
const items = new Map();

// The one in `list` a reference's segment names: by its ID, else by its title, which no other may share.
function named(list, segment, what) {
  const byId = list.find((x) => x.id === segment);
  if (byId) return byId;
  const titled = list.filter((x) => x.title === segment);
  if (titled.length === 1) return titled[0];
  throw new Error(
    titled.length
      ? `${titled.length} ${what}s are named ${segment}; put the ${what}'s ID in the reference`
      : `no ${what} ${segment} that this service account can read`,
  );
}

// op://vault/item[/section]/field[?attribute=...]: the websites of exactly the item the reference names, for the
// origin check.
async function websites(reference) {
  const [vaultName, itemName] = reference.slice("op://".length).split("?")[0].split("/");
  vaults ??= await client.vaults.list();
  const vault = named(vaults, vaultName, "vault");
  if (!items.has(vault.id)) items.set(vault.id, await client.items.list(vault.id));
  const item = named(items.get(vault.id), itemName, "item");
  return (item.websites ?? []).map((w) => w.url).filter(Boolean);
}

// op://vault/item: a Credit Card item's details, for an approved purchase's fill only.
async function card(reference) {
  const [vaultName, itemName] = reference.slice("op://".length).split("?")[0].split("/");
  vaults ??= await client.vaults.list();
  const vault = named(vaults, vaultName, "vault");
  if (!items.has(vault.id)) items.set(vault.id, await client.items.list(vault.id));
  const overview = named(items.get(vault.id), itemName, "item");
  if (overview.category !== "CreditCard") throw new Error(`${itemName} is not a Credit Card item`);
  const item = await client.items.get(vault.id, overview.id);
  const fields = item.fields ?? [];
  const field = (ids, types, titles) =>
    (fields.find((f) => ids.includes(f.id)) ??
      fields.find((f) => types.includes(f.fieldType)) ??
      fields.find((f) => titles.test(f.title ?? "")))?.value ?? "";
  return {
    number: field(["ccnum", "number"], ["CreditCardNumber"], /number/i),
    expiry: field(["expiry"], ["MonthYear"], /expir/i),
    cvc: field(["cvv"], [], /verification|cvv|cvc|security code/i),
    name: field(["cardholder"], [], /cardholder|name on card/i),
  };
}

// A field of an Identity, Passport, Driver License or Social Security item, for an approved secure input only.
const IDENTITIES = ["Identity", "Passport", "DriverLicense", "SocialSecurityNumber"];
async function identity(reference) {
  const [vaultName, itemName] = reference.slice("op://".length).split("?")[0].split("/");
  vaults ??= await client.vaults.list();
  const vault = named(vaults, vaultName, "vault");
  if (!items.has(vault.id)) items.set(vault.id, await client.items.list(vault.id));
  const overview = named(items.get(vault.id), itemName, "item");
  if (!IDENTITIES.includes(overview.category)) {
    throw new Error(`${itemName} is not an Identity, Passport, Driver License or Social Security item`);
  }
  return await client.secrets.resolve(reference);
}

// Every Credit Card item the token reads: names and references only.
async function cards() {
  vaults ??= await client.vaults.list();
  const out = [];
  for (const vault of vaults) {
    if (!items.has(vault.id)) items.set(vault.id, await client.items.list(vault.id));
    const all = items.get(vault.id);
    for (const item of all.filter((i) => i.category === "CreditCard")) {
      const plain = (s) => !/[/?\r\n]/.test(s);
      const vaultPart = plain(vault.title) && vaults.filter((v) => v.title === vault.title).length === 1 ? vault.title : vault.id;
      const itemPart = plain(item.title) && all.filter((i) => i.title === item.title).length === 1 ? item.title : item.id;
      out.push({ ref: `op://${vaultPart}/${itemPart}`, title: item.title, vault: vault.title });
    }
  }
  return out;
}

// The kinds fleetd's vault imports, by 1Password category.
const IMPORTS = ["Login", "Password", "CreditCard", "Identity"];

// The items a vault import may take whose title or website has `query` in it: overviews only, never a value.
async function search(query) {
  vaults ??= await client.vaults.list();
  const want = String(query ?? "").toLowerCase();
  const out = [];
  for (const vault of vaults) {
    if (!items.has(vault.id)) items.set(vault.id, await client.items.list(vault.id));
    const all = items.get(vault.id);
    for (const item of all.filter((i) => IMPORTS.includes(i.category))) {
      const sites = (item.websites ?? []).map((w) => w.url).filter(Boolean);
      if (want && ![item.title, ...sites].some((t) => String(t).toLowerCase().includes(want))) continue;
      const plain = (s) => !/[/?\r\n]/.test(s);
      const vaultPart = plain(vault.title) && vaults.filter((v) => v.title === vault.title).length === 1 ? vault.title : vault.id;
      const itemPart = plain(item.title) && all.filter((i) => i.title === item.title).length === 1 ? item.title : item.id;
      out.push({ ref: `op://${vaultPart}/${itemPart}`, title: item.title, category: item.category, vault: vault.title, sites });
      if (out.length >= 200) return out;
    }
  }
  return out;
}

// op://vault/item: an item's fields, for an import the person confirmed; the node seals them to the hub.
async function read(reference) {
  const [vaultName, itemName] = reference.slice("op://".length).split("?")[0].split("/");
  vaults ??= await client.vaults.list();
  const vault = named(vaults, vaultName, "vault");
  if (!items.has(vault.id)) items.set(vault.id, await client.items.list(vault.id));
  const overview = named(items.get(vault.id), itemName, "item");
  if (!IMPORTS.includes(overview.category)) throw new Error(`${itemName} is not a login, card or identity item`);
  const item = await client.items.get(vault.id, overview.id);
  return {
    title: item.title,
    category: item.category,
    sites: (item.websites ?? []).map((w) => w.url).filter(Boolean),
    notes: item.notes ?? "",
    fields: (item.fields ?? []).map((f) => ({ id: f.id, title: f.title ?? "", type: f.fieldType, value: f.value ?? "", details: f.details?.content })),
  };
}

for await (const line of createInterface({ input: process.stdin })) {
  if (token === undefined) {
    token = JSON.parse(line).token ?? "";
    continue;
  }
  let answer;
  try {
    client ??= await createClient({ auth: token, integrationName: "fleetd", integrationVersion: "1" });
    const { ref, vaults: list, card: cardRef, cards: listCards, identity: identityRef, search: query, read: readRef } = JSON.parse(line);
    if (query !== undefined) {
      answer = { items: await search(query) };
    } else if (readRef) {
      answer = { item: await read(readRef) };
    } else if (list) {
      vaults ??= await client.vaults.list();
      answer = { vaults: vaults.map((v) => v.title) };
    } else if (listCards) {
      answer = { cards: await cards() };
    } else if (cardRef) {
      answer = { card: await card(cardRef) };
    } else if (identityRef) {
      answer = { value: await identity(identityRef), urls: [] };
    } else {
      const urls = await websites(ref);
      // An item without a website fills nowhere, so its value isn't read.
      answer = urls.length ? { value: await client.secrets.resolve(ref), urls } : { urls };
    }
  } catch (e) {
    const message = String(e?.message ?? e).slice(0, 300);
    const rateLimited = e instanceof RateLimitExceededError || /rate.?limit|too many requests|429/i.test(message);
    answer = { error: message, rateLimited };
  }
  process.stdout.write(JSON.stringify(answer) + "\n");
}
