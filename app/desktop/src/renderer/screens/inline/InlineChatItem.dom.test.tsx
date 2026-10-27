// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import data from "../../../../fixtures/inline/items.json";
import type { ChatItem } from "../../../shared/contracts";
import type { CallOutcome, HubFrame, SecretOutcome } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { InlineChatItem } from "./InlineChatItem";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const items = data.items as unknown as ChatItem[];
const item = (id: string): ChatItem => {
  const it = items.find((x) => x.requestId === id);
  if (it === undefined) throw new Error(`no item ${id}`);
  return it;
};

const KEY = "Az+6kf/abi0V7SO+sn4h++sIgyPoNDAneLBDFaJf3TA=";
const snapshot: HubFrame = {
  t: "snapshot",
  snapshot: {
    cursor: 1,
    attention: [],
    machines: [{ machineId: "devbox", name: "devbox", nodeVersion: "1", status: "online", lastSeenAt: "2026-10-19T10:00:00.000Z", tags: [], boxPubKey: KEY }],
    projects: [],
  },
};

/** A hub whose approval_answer does what `answer` says; requests_list answers `requests`, every other read empty. */
const mount = (answer: (input: unknown) => Promise<CallOutcome>) => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const answers: unknown[] = [];
  const requests: { current: Record<string, unknown>[] } = { current: [] };
  const hub: HubApi = {
    call: (tool, input) => {
      if (tool !== "approval_answer") return Promise.resolve({ ok: true, output: tool === "requests_list" ? { requests: requests.current } : {} });
      answers.push(input);
      return answer(input);
    },
    subscribe: (l) => ((listener = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  const layer = createDataLayer(hub);
  return { layer, answers, requests, send: (f: HubFrame) => listener(f) };
};

let hubs = 0;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const render = async (id: string, answer: (input: unknown) => Promise<CallOutcome> = () => Promise.resolve({ ok: true, output: {} })) => {
  const hub = mount(answer);
  await act(async () => {
    root.render(
      <UiProvider>
        <DataProvider layer={hub.layer}>
          <InlineChatItem item={item(id)} />
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  // A hub of its own per test: what the person did is kept per hub and request.
  hubs += 1;
  await act(async () => {
    hub.send({ t: "state", state: { phase: "live", hub: `devbox-${String(hubs)}:4710`, protocol: 1 } });
    hub.send(snapshot);
    await Promise.resolve();
  });
  const show = async (shown: string | null) => {
    await act(async () => {
      root.render(
        <UiProvider>
          <DataProvider layer={hub.layer}>{shown === null ? null : <InlineChatItem item={item(shown)} />}</DataProvider>
        </UiProvider>,
      );
      await Promise.resolve();
    });
  };
  return { ...hub, show };
};

const button = (name: string): HTMLButtonElement => {
  const b = [...host.querySelectorAll("button")].find((x) => x.textContent.trim() === name);
  if (b === undefined) throw new Error(`no button ${name} in: ${host.textContent}`);
  return b;
};
const one = (selector: string): HTMLElement => {
  const el = host.querySelector<HTMLElement>(selector);
  if (el === null) throw new Error(`no ${selector} in: ${host.textContent}`);
  return el;
};
const has = (name: string) => [...host.querySelectorAll("button")].some((x) => x.textContent.trim() === name);
const press = async (target: Element, key: string, repeat = false) => {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, repeat, bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
};
const click = async (b: HTMLButtonElement) => {
  await act(async () => {
    b.click();
    await Promise.resolve();
  });
};
const settle = () => act(async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
});

describe("a command that can't be undone", () => {
  it("asks once more in the card; Esc backs out, a held Enter never runs it, a second Enter does", async () => {
    const hub = await render("Q4");
    await click(button("Approve"));
    expect(hub.answers).toEqual([]);
    expect(host.textContent).toContain("Run this on devbox? It can't be undone.");
    const question = one("[role=group]");
    expect(document.activeElement).toBe(question);

    await press(question, "Escape");
    expect(has("Yes, run it")).toBe(false);
    expect(document.activeElement).toBe(button("Approve"));
    expect(hub.answers).toEqual([]);

    await click(button("Approve"));
    await press(one("[role=group]"), "Enter", true);
    expect(hub.answers).toEqual([]);
    await press(one("[role=group]"), "Enter");
    await settle();
    expect(hub.answers).toEqual([{ requestId: "Q4", decision: "approve" }]);
    // Answered: one line, and focus stays on it.
    expect(host.textContent).toContain("Approved, running…");
    expect(document.activeElement?.getAttribute("aria-expanded")).toBe("false");
  });
  it("still asks when its row comes back after the chat list dropped it, without taking focus", async () => {
    const hub = await render("Q4");
    await click(button("Approve"));
    await hub.show(null);
    act(() => document.body.focus());
    await hub.show("Q4");
    expect(has("Yes, run it")).toBe(true);
    expect(host.contains(document.activeElement)).toBe(false);
  });
});

describe("a focused approval", () => {
  it("approves on Enter without a second ask when it can be undone", async () => {
    const hub = await render("Q10");
    const card = one("section");
    act(() => card.focus());
    await press(card, "Enter");
    await settle();
    expect(hub.answers).toEqual([{ requestId: "Q10", decision: "approve" }]);
  });

  it("denies on Esc", async () => {
    const hub = await render("Q10");
    const card = one("section");
    act(() => card.focus());
    await press(card, "Escape");
    await settle();
    expect(hub.answers).toEqual([{ requestId: "Q10", decision: "deny" }]);
    expect(host.textContent).toContain("Denied, nothing ran");
  });
});

describe("a failed answer", () => {
  it("is one plain line with Retry, never the hub's message", async () => {
    let fail = true;
    const hub = await render("Q10", () =>
      Promise.resolve(fail ? { ok: false, error: { code: "failed", message: '{"requestId":"Q10"} exploded' } } : { ok: true, output: {} }),
    );
    await click(button("Approve"));
    await settle();
    const alert = host.querySelector("[role=alert]");
    expect(alert?.textContent).toBe("Not approved: something went wrong.Retry");
    expect(host.textContent).not.toContain("exploded");
    fail = false;
    await click(button("Retry"));
    await settle();
    expect(hub.answers).toHaveLength(2);
    expect(host.querySelector("[role=alert]")).toBeNull();
    expect(host.textContent).toContain("Approved, running…");
  });

  it("ends a wait that never answers, instead of spinning for ever", async () => {
    vi.useFakeTimers();
    await render("Q10", () => new Promise(() => undefined));
    await click(button("Approve"));
    expect(button("Approve").disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(35_000);
    });
    expect(host.querySelector("[role=alert]")?.textContent).toBe("Not approved: no answer in time.Retry");
    expect(button("Approve").disabled).toBe(false);
  });
});

describe("a secret save", () => {
  const type = async (value: string) => {
    const field = one("input[type=password]") as HTMLInputElement;
    await act(async () => {
      // React tracks the value it last set; the native setter makes the change one it sees, as typing does.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    return field;
  };

  it("keeps what was typed until it is saved, so Retry sends it again", async () => {
    const sent: string[] = [];
    let outcome: SecretOutcome = { ok: false, error: { code: "machine_offline", message: "devbox (machine_offline): node not connected" } };
    vi.stubGlobal("fleetd", { secret: { submit: (_hub: string, r: { value: string }) => (sent.push(r.value), Promise.resolve(outcome)) } });
    const hub = await render("Q1");
    await type("sk_test_123");
    await click(button("Save secret"));
    await settle();
    expect(host.querySelector("[role=alert]")?.textContent).toBe("Not saved: devbox is offline.Retry");
    expect((one("input[type=password]") as HTMLInputElement).value).toBe("sk_test_123");
    // The chat list drops the row and brings it back: the value and the failure are still there.
    await hub.show(null);
    await hub.show("Q1");
    expect((one("input[type=password]") as HTMLInputElement).value).toBe("sk_test_123");
    expect(host.querySelector("[role=alert]")?.textContent).toBe("Not saved: devbox is offline.Retry");

    outcome = { ok: true, fingerprint: "ab12cd34" };
    await click(button("Retry"));
    await settle();
    expect(sent).toEqual(["sk_test_123", "sk_test_123"]);
    expect(host.textContent).toContain("Secret saved");
    expect(host.textContent).not.toContain("ab12cd34");
  });

  it("stops saying Saving… when the save throws", async () => {
    vi.stubGlobal("fleetd", { secret: { submit: () => Promise.reject(new Error("ipc gone")) } });
    await render("Q1");
    await type("sk_test_123");
    await click(button("Save secret"));
    await settle();
    expect(has("Saving…")).toBe(false);
    expect(host.querySelector("[role=alert]")?.textContent).toBe("Not saved: something went wrong.Retry");
  });
});

describe("an answered item", () => {
  it("is one line that opens back up to the whole card", async () => {
    await render("Q5");
    const fold = one("button[aria-expanded]") as HTMLButtonElement;
    expect(fold.textContent).toBe("Approved, ran in 12sClear the staging CDN cache; each purge is billed");
    expect(host.textContent).not.toContain("purged 412 objects");
    await click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(host.textContent).toContain("purged 412 objects");
  });
});

describe("a request the hub reopens", () => {
  // As requests_list holds it: the item's state, and its evidence (why it is open again) as the note.
  const request = (requestId: string, state: string, evidence?: string, answeredAt?: string) => ({
    requestId,
    kind: "approval",
    state,
    ...(evidence === undefined ? {} : { evidence }),
    ...(answeredAt === undefined ? {} : { answeredAt }),
  });
  let seq = 1;
  const updated = (requestId: string, state: string): HubFrame => {
    seq += 1;
    return { t: "event", event: { seq, at: "2026-10-19T10:31:00.000Z", type: "request.updated", summary: "", data: { requestId, kind: "approval", state } } };
  };
  // What a request.* event sets off: the batched refetch of requests_list, and its answer.
  const refetched = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
  const OFFLINE = "Not run: devbox's node was offline when you approved. Approve again once it is online.";

  it("shows it open again with why, never the approval it no longer has", async () => {
    vi.useFakeTimers();
    seq = 1;
    const hub = await render("Q10");
    hub.requests.current = [request("Q10", "open")];
    act(() => {
      hub.send(updated("Q10", "open"));
    });
    await refetched();
    await click(button("Approve"));
    await settle();
    expect(host.textContent).toContain("Approved, running…");

    // The hub approved it, then reopened it: new evidence, no answeredAt.
    hub.requests.current = [request("Q10", "approved", undefined, "2026-10-19T10:31:00.000Z")];
    act(() => {
      hub.send(updated("Q10", "approved"));
    });
    await refetched();
    hub.requests.current = [request("Q10", "open", OFFLINE)];
    act(() => {
      hub.send(updated("Q10", "open"));
    });
    await refetched();
    expect(host.textContent).not.toContain("Approved, running…");
    expect(host.textContent).toContain(OFFLINE);
    expect(button("Approve again").disabled).toBe(false);
  });

  it("shows it open again when the reopen says what it said before, and both land in one refetch", async () => {
    vi.useFakeTimers();
    seq = 1;
    const hub = await render("Q7");
    hub.requests.current = [request("Q7", "open", OFFLINE)];
    act(() => {
      hub.send(updated("Q7", "open"));
    });
    await refetched();
    await click(button("Approve again"));
    await click(button("Yes, run it"));
    await settle();
    expect(host.textContent).toContain("Approved, running…");

    // The node is still offline: approved and reopened with the same evidence, and the list reads the same as before.
    act(() => {
      hub.send(updated("Q7", "approved"));
      hub.send(updated("Q7", "open"));
    });
    await refetched();
    expect(host.textContent).not.toContain("Approved, running…");
    expect(button("Approve again").disabled).toBe(false);
  });

  it("shows it open again after a link drop, when the reopen in the gap says what it said before", async () => {
    vi.useFakeTimers();
    seq = 1;
    const hub = await render("Q7");
    hub.requests.current = [request("Q7", "open", OFFLINE)];
    act(() => {
      hub.send(updated("Q7", "open"));
    });
    await refetched();
    await click(button("Approve again"));
    await click(button("Yes, run it"));
    await settle();
    expect(host.textContent).toContain("Approved, running…");

    // The link drops; the hub approves and reopens it in the gap, saying the same, and its events are never sent.
    // The fresh snapshot's reread is the only news.
    act(() => {
      hub.send({ t: "state", state: { phase: "retrying", hub: `devbox-${String(hubs)}:4710`, reason: "The hub stopped answering", retryAt: 0 } });
    });
    act(() => {
      hub.send({ t: "state", state: { phase: "live", hub: `devbox-${String(hubs)}:4710`, protocol: 1 } });
      hub.send({ ...snapshot, snapshot: { ...snapshot.snapshot, cursor: 50 } });
    });
    await refetched();
    expect(host.textContent).not.toContain("Approved, running…");
    expect(button("Approve again").disabled).toBe(false);
  });

  it("still asks before a command that can't be undone runs, after the hub's events start again from 1", async () => {
    vi.useFakeTimers();
    const hub = await render("Q4");
    hub.requests.current = [request("Q4", "open")];
    // Events from before the hub was reset, with numbers far above its new ones.
    seq = 899;
    act(() => {
      hub.send(updated("Q4", "open"));
    });
    await refetched();
    act(() => {
      hub.send({ ...snapshot, snapshot: { ...snapshot.snapshot, cursor: 5 } });
    });
    await refetched();
    await click(button("Approve"));
    expect(host.textContent).toContain("Run this on devbox? It can't be undone.");
    await click(button("Yes, run it"));
    await settle();
    expect(host.textContent).toContain("Approved, running…");
    expect(has("Approve")).toBe(false);
  });

  it("keeps the answer when the requests read doesn't list the request (past the newest 100)", async () => {
    vi.useFakeTimers();
    seq = 1;
    const hub = await render("Q10");
    await click(button("Approve"));
    await settle();
    expect(host.textContent).toContain("Approved, running…");
    act(() => {
      hub.send(updated("Q10", "approved"));
    });
    await refetched();
    expect(host.textContent).toContain("Approved, running…");
    expect(has("Approve")).toBe(false);
  });

  it("drops a failed answer's line once the hub's view moves on", async () => {
    vi.useFakeTimers();
    seq = 1;
    const hub = await render("Q10", () => Promise.resolve({ ok: false, error: { code: "machine_offline", message: "node not connected" } }));
    hub.requests.current = [request("Q10", "open")];
    act(() => {
      hub.send(updated("Q10", "open"));
    });
    await refetched();
    await click(button("Approve"));
    await settle();
    expect(host.querySelector("[role=alert]")?.textContent).toBe("Not approved: devbox is offline.Retry");

    // Approved on another computer, then reopened: the old failure is not this card's news.
    hub.requests.current = [request("Q10", "approved", undefined, "2026-10-19T10:31:00.000Z")];
    act(() => {
      hub.send(updated("Q10", "approved"));
    });
    await refetched();
    hub.requests.current = [request("Q10", "open", OFFLINE)];
    act(() => {
      hub.send(updated("Q10", "open"));
    });
    await refetched();
    expect(host.querySelector("[role=alert]")).toBeNull();
    expect(button("Approve again").disabled).toBe(false);
  });
});
