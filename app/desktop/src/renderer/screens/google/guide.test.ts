import { describe, expect, it } from "vitest";
import { cloudProject, googleParts, realtimeParts } from "./guide";

const values = (parts: ReturnType<typeof googleParts>) => parts.flatMap((p) => p.values ?? []);
const value = (parts: ReturnType<typeof googleParts>, label: string) => values(parts).find((v) => v.label === label);

describe("Administration › Google's guide", () => {
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
});
