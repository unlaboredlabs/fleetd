// The owner's Delete Team on the phone against a stand-in for a cloud team's address: who sees it, the call with the
// phone's key and the name typed, and the team's refusal in its own words.
import { describe, expect, it } from "vitest";
import { deleteTeam, deleteTeamShown, disconnectShown } from "./team";

const HUB = { hub: "https://acme.fleetd.dev/", key: "fk_phone_key", hubName: "acme" };

describe("Delete Team on the phone", () => {
  it("shows for the owner of a team that came with the account only", () => {
    expect(deleteTeamShown({ cloud: true }, "owner")).toBe(true);
    expect(deleteTeamShown({ cloud: true }, "admin")).toBe(false);
    expect(deleteTeamShown({ cloud: true }, undefined)).toBe(false);
    expect(deleteTeamShown({}, "owner")).toBe(false);
  });

  it("keeps Disconnect only where it does something Sign Out doesn't", () => {
    expect(disconnectShown({ cloud: true }, true)).toBe(false);
    expect(disconnectShown({ cloud: true }, false)).toBe(true);
    expect(disconnectShown({}, true)).toBe(true);
    expect(disconnectShown({}, false)).toBe(true);
  });

  it("sends the name typed with the phone's key, and says the team's refusal as it is", async () => {
    const sent: Array<{ url: string; auth: string | null; body: unknown }> = [];
    let answer = { status: 409, body: { code: "running", message: "An agent is running in this team.", fix: "Stop them, then delete the team." } as unknown };
    const fetch = (url: string, init: RequestInit): Promise<Response> => {
      sent.push({ url, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(init.body as string) });
      return Promise.resolve(new Response(JSON.stringify(answer.body), { status: answer.status }));
    };
    expect(await deleteTeam(HUB, " acme ", fetch)).toEqual({ ok: false, failure: { message: "An agent is running in this team.", fix: "Stop them, then delete the team." } });
    answer = { status: 200, body: { deleted: "acme" } };
    expect(await deleteTeam(HUB, "acme", fetch)).toEqual({ ok: true, value: null });
    expect(sent).toEqual([
      { url: "https://acme.fleetd.dev/accounts/v1/team/delete", auth: "Bearer fk_phone_key", body: { name: "acme" } },
      { url: "https://acme.fleetd.dev/accounts/v1/team/delete", auth: "Bearer fk_phone_key", body: { name: "acme" } },
    ]);
  });
});
