import { describe, expect, it } from "vitest";
import fixtures from "../../../../fixtures/setup/steps.json" with { type: "json" };
import { cloudProject, googleParts, realtimeParts } from "./guide";

const values = (parts: ReturnType<typeof googleParts>) => parts.flatMap((p) => p.values ?? []);
const value = (parts: ReturnType<typeof googleParts>, label: string) => values(parts).find((v) => v.label === label);

describe("Hub accounts › Google's guide", () => {
  it("is a Desktop app client with the loopback redirect and the hub's exact scopes, so a plain-HTTP hub works", () => {
    const parts = googleParts("http://devbox:4790");
    expect(value(parts, "Application type")?.value).toBe("Desktop app");
    expect(value(googleParts("https://devbox.example.net"), "Redirect URI")?.value).toBe("http://127.0.0.1");
    expect(value(parts, "Draft and send")?.value).toBe("https://www.googleapis.com/auth/gmail.compose");
    expect(value(parts, "Drive")?.value).toBe("https://www.googleapis.com/auth/drive");
  });

  it("sets up Gmail in real time with a topic Gmail may publish to, and a key that may only read its subscription", () => {
    const parts = realtimeParts("http://devbox:4790");
    expect(parts.every((p) => p.optional === true)).toBe(true);
    expect(value(parts, "Publisher on the topic")?.value).toBe("gmail-api-push@system.gserviceaccount.com");
    expect(value(parts, "Subscriber on the subscription")?.value).toBe("fleetd-gmail-reader@fleetd-devbox.iam.gserviceaccount.com");
    const shell = value(parts, "Or in Cloud Shell")?.value ?? "";
    expect(shell).toContain("--role=roles/pubsub.publisher");
    expect(shell).toContain("subscriptions add-iam-policy-binding fleetd-gmail-hub");
    expect(shell).toContain("--role=roles/pubsub.subscriber");
    expect(cloudProject("http://devbox:4790")).toBe("fleetd-devbox");
  });

  // The words around them (plain values: what to pick, where to paste) may name this page's own fields.
  it("gives the same titles and values to paste as the hub's Google step, so the two can't drift", () => {
    type Part = { title: string; values?: ReadonlyArray<{ label: string; value: string; plain?: boolean }> };
    const pairs = (parts: ReadonlyArray<Part>) => parts.map((p) => [p.title, (p.values ?? []).filter((v) => v.plain !== true).map((v) => [v.label, v.value])]);
    const hub = (fixtures.guides as ReadonlyArray<{ id: string; parts: ReadonlyArray<Part> }>).find((g) => g.id === "google");
    expect(pairs([...googleParts(fixtures.hub), ...realtimeParts(fixtures.hub)])).toEqual(pairs(hub?.parts ?? []));
  });
});
