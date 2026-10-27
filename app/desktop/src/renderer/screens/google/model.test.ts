import { describe, expect, it } from "vitest";
import type { GoogleGetOutput } from "../../../shared/contracts";
import { boxesOf, clientIdProblem, googleView, lapsedLine, missingScopes, notHolding, SCOPES, secretProblem } from "./model";

const AT = "2026-10-27T09:00:00.000Z";
const ada = { machineId: "devbox", projectId: "ada" };
const client = { clientId: "1-a.apps.googleusercontent.com", sealedOn: [{ machineId: "devbox", fingerprint: "9c41e0b2" }], updatedAt: AT };
const get = (patch: Partial<GoogleGetOutput>): GoogleGetOutput => ({ scopes: [...SCOPES], redirect: "http://127.0.0.1", mailMode: "polling", ...patch });
const account = { projectRef: ada, email: "sam@example.com", scopes: [...SCOPES], connectedAt: AT };

describe("a Navi's Google connection", () => {
  it("is one of five states, read from google_get", () => {
    expect(googleView(get({}), "devbox").kind).toBe("no-client");
    expect(googleView(get({ client }), "buildbox")).toEqual({ kind: "not-held", machineId: "buildbox" });
    expect(googleView(get({ client }), "devbox").kind).toBe("none");
    expect(googleView(get({ client, account }), "devbox")).toEqual({ kind: "connected", account, missing: [] });
    // An account is shown whatever the client: it is the Navi's to disconnect.
    expect(googleView(get({ account: { ...account, lapsed: "revoked" } }), "devbox")).toMatchObject({ kind: "lapsed", why: "revoked" });
  });

  it("names what was unticked at Google, reading Google's userinfo.email as email", () => {
    const granted = ["openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/gmail.readonly"];
    expect(missingScopes(SCOPES, granted)).toEqual(["drafting and sending mail", "Calendar", "Drive"]);
    expect(missingScopes(SCOPES, SCOPES)).toEqual([]);
    expect(lapsedLine("the access was revoked.")).toBe("Google stopped taking this connection: the access was revoked.");
  });

  it("checks what an admin pastes before it is sealed", () => {
    expect(clientIdProblem("")).not.toBeNull();
    expect(clientIdProblem("GOCSPX-abc")).toContain("apps.googleusercontent.com");
    expect(clientIdProblem(" 1-a.apps.googleusercontent.com ")).toBeNull();
    expect(secretProblem("1-a.apps.googleusercontent.com")).toContain("Client ID");
    expect(secretProblem("GOCSPX-a b")).toContain("space");
    expect(secretProblem("GOCSPX-abc")).toBeNull();
  });

  it("seals to every machine with a box key, and names those that don't hold the client", () => {
    const boxes = boxesOf([{ machineId: "devbox", boxPubKey: "k" }, { machineId: "old" }, { machineId: "buildbox", boxPubKey: "k" }]);
    expect(boxes.map((b) => b.machineId)).toEqual(["devbox", "buildbox"]);
    expect(notHolding(get({ client }), boxes)).toEqual(["buildbox"]);
  });
});
