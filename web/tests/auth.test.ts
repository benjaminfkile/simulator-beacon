import { describe, it, expect } from "vitest";
import { buildManagerSettings, snapshotFromUser } from "../src/auth.js";

describe("buildManagerSettings", () => {
  it("wires the redirect URIs off the origin and the Cognito /logout URL off the domain", () => {
    const s = buildManagerSettings({
      config: {
        apiBaseUrl: "https://api.example",
        cognitoAuthority:
          "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC123",
        cognitoDomain: "https://pool.auth.example",
        cognitoClientId: "client-abc",
      },
      origin: "https://sim.example",
    });
    expect(s.authority).toBe(
      "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC123",
    );
    expect(s.client_id).toBe("client-abc");
    expect(s.redirect_uri).toBe("https://sim.example/callback");
    expect(s.post_logout_redirect_uri).toBe("https://sim.example/");
    expect(s.response_type).toBe("code");
    expect(s.metadataSeed?.end_session_endpoint).toBe(
      "https://pool.auth.example/logout?client_id=client-abc&logout_uri=https%3A%2F%2Fsim.example%2F",
    );
  });
});

describe("snapshotFromUser", () => {
  it("returns an empty snapshot when no user is loaded", () => {
    const s = snapshotFromUser(null, "admin");
    expect(s.idToken).toBeNull();
    expect(s.hasAdminRole).toBe(false);
  });

  it("marks hasAdminRole true when the admin group is present", () => {
    const user = {
      id_token: "id.tok",
      access_token: "acc.tok",
      expires_at: 999999,
      expired: false,
      profile: {
        sub: "u-1",
        email: "person@example.com",
        "cognito:username": "person",
        "cognito:groups": ["admin"],
      },
    } as unknown as import("oidc-client-ts").User;
    const s = snapshotFromUser(user, "admin");
    expect(s.hasAdminRole).toBe(true);
    expect(s.idToken).toBe("id.tok");
    expect(s.email).toBe("person@example.com");
    expect(s.username).toBe("person");
    expect(s.groups).toEqual(["admin"]);
  });

  it("marks hasAdminRole false when the group is absent (the 'no role' path)", () => {
    const user = {
      id_token: "id.tok",
      access_token: "acc.tok",
      expires_at: 999999,
      expired: false,
      profile: {
        sub: "u-1",
        email: "person@example.com",
        "cognito:groups": ["editor"],
      },
    } as unknown as import("oidc-client-ts").User;
    const s = snapshotFromUser(user, "admin");
    expect(s.hasAdminRole).toBe(false);
    expect(s.groups).toEqual(["editor"]);
  });
});
