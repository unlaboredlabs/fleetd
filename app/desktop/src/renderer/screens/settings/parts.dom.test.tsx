// @vitest-environment happy-dom
// A Settings row at rest is its title and its control; what explains it is its hint (parts.tsx): shown under the
// title on hover and on keyboard focus, and in the page for a screen reader all along.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Button } from "../../ui";
import { HintLines, SettingsList, SettingsListRow, SettingsRow, SettingsSection, SwitchRow } from "./parts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <SettingsSection title="Agents" hint="How many run at once, and on what.">
        <SwitchRow title="Only me" hint="On: only you see this project." line={null} checked={false} onCheckedChange={() => undefined} />
        <SettingsRow title="Skills" hint="What agents can do here." line="None." />
        <SettingsRow title="Archive" control={<Button>Archive…</Button>} />
        <SettingsRow
          title="Role"
          hint={
            <HintLines
              lines={[
                ["Member", "their own projects"],
                ["Admin", "the hub too"],
              ]}
            />
          }
          control={<Button>Change</Button>}
        />
        <SettingsList label="Prompts">
          <SettingsListRow label="Lead" name="Lead" hint="What the lead is told." />
        </SettingsList>
      </SettingsSection>,
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const named = (label: string) => {
  const found = host.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (!found) throw new Error(`no ${label}`);
  return found;
};
const tip = () => document.querySelector('[role="tooltip"]');
const settle = () => {
  act(() => {
    vi.advanceTimersByTime(1000);
  });
};
const hover = (el: Element) => {
  act(() => {
    el.dispatchEvent(new PointerEvent("pointermove", { pointerType: "mouse", bubbles: true }));
  });
  settle();
};
const escape = () => {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  settle();
};
/** What a screen reader says after the name: the words `aria-describedby` points at (first, before an open tooltip's). */
const described = (el: Element) => document.getElementById((el.getAttribute("aria-describedby") ?? "").split(" ")[0] ?? "")?.textContent;

it("at rest a row is its title and its control: no hint showing, no question mark", () => {
  expect(tip()).toBeNull();
  expect(host.querySelector("svg")).toBeNull();
  // The hint's words are in the page, out of sight, never in the row's visible line.
  const hint = named("Only me").querySelector("[data-hint]");
  expect(hint?.textContent).toBe("On: only you see this project.");
  expect(hint?.className).toContain("srOnly");
});

it("shows a row's hint while the pointer rests on its title, until Escape", () => {
  const row = named("Only me");
  const title = row.querySelector("label") as HTMLElement;
  hover(title);
  expect(tip()?.textContent).toBe("On: only you see this project.");
  escape();
  expect(tip()).toBeNull();
});

it("shows the same hint from the row's control: the whole head of the row is where it rests", () => {
  hover(named("Only me").querySelector('[role="switch"]') as HTMLElement);
  expect(tip()?.textContent).toBe("On: only you see this project.");
});

it("shows it on keyboard focus of the row's control, which a screen reader hears described by it", () => {
  const toggle = named("Only me").querySelector<HTMLElement>('[role="switch"]');
  if (!toggle) throw new Error("no switch");
  act(() => toggle.focus());
  settle();
  expect(tip()?.textContent).toBe("On: only you see this project.");
  expect(described(toggle)).toBe("On: only you see this project.");
  expect(described(named("Only me"))).toBe("On: only you see this project.");
  act(() => toggle.blur());
  settle();
  expect(tip()).toBeNull();
});

it("a hinted row with no control takes keyboard focus on its title; one with nothing to explain takes none", () => {
  const title = [...named("Skills").querySelectorAll<HTMLElement>("[tabindex='0']")];
  expect(title.map((t) => t.textContent)).toEqual(["Skills"]);
  act(() => title[0]?.focus());
  settle();
  expect(tip()?.textContent).toBe("What agents can do here.");
  // Its state stays in sight under the title.
  expect(named("Skills").textContent).toContain("None.");
  expect(named("Archive").querySelector("[tabindex='0']")).toBeNull();
  expect(named("Archive").querySelector("[data-hint]")).toBeNull();
  expect(named("Archive").hasAttribute("aria-describedby")).toBe(false);
});

it("a section's hint is on its label, and a list row's on the row", () => {
  const label = named("Agents").querySelector("h2");
  if (!label) throw new Error("no label");
  expect(label.tabIndex).toBe(0);
  hover(label);
  expect(tip()?.textContent).toBe("How many run at once, and on what.");
  expect(described(named("Agents"))).toBe("How many run at once, and on what.");
  escape();
  hover(named("Lead"));
  expect(tip()?.textContent).toBe("What the lead is told.");
  expect(described(named("Lead"))).toBe("What the lead is told.");
});

it("a hint for several choices says each on a line of its own, its name first", () => {
  const lines = [...(named("Role").querySelector("[data-hint]")?.children ?? [])].map((l) => l.textContent);
  expect(lines).toEqual(["Member: their own projects", "Admin: the hub too"]);
});
