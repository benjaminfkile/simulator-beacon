// Admin-pool sign-in with oidc-client-ts, per simulator-beacon.md 5. One page:
// signinRedirect() sends the browser to the pool, the callback route runs
// signinRedirectCallback(), signoutRedirect() ends the session. The ID token
// is what the control API accepts, so `user.id_token` is what the api module
// carries.
//
// The pool is Cognito: it does not honour end_session_endpoint the way OIDC
// dictates, and needs the hosted-UI /logout URL with client_id and
// logout_uri. UserManager is created with metadata that points at that URL so
// signoutRedirect() lands on the site's origin.

import {
  UserManager,
  WebStorageStateStore,
  type User,
  type UserManagerSettings,
} from "oidc-client-ts";
import type { WebConfig } from "./config.js";

export interface AuthOptions {
  config: WebConfig;
  origin: string;
  storage?: Storage;
}

export function buildManagerSettings(opts: AuthOptions): UserManagerSettings {
  const { config, origin, storage } = opts;
  const cognitoDomain = config.cognitoDomain.replace(/\/$/, "");
  const logoutUri = `${origin}/`;
  const settings: UserManagerSettings = {
    authority: config.cognitoAuthority,
    client_id: config.cognitoClientId,
    redirect_uri: `${origin}/callback`,
    post_logout_redirect_uri: logoutUri,
    response_type: "code",
    scope: "openid email profile",
    loadUserInfo: false,
    automaticSilentRenew: true,
    monitorSession: false,
    metadataSeed: {
      end_session_endpoint: `${cognitoDomain}/logout?client_id=${encodeURIComponent(
        config.cognitoClientId,
      )}&logout_uri=${encodeURIComponent(logoutUri)}`,
    },
    userStore: storage
      ? new WebStorageStateStore({ store: storage })
      : new WebStorageStateStore({ store: window.localStorage }),
    stateStore: storage
      ? new WebStorageStateStore({ store: storage })
      : new WebStorageStateStore({ store: window.localStorage }),
  };
  return settings;
}

export interface SessionSnapshot {
  idToken: string | null;
  accessToken: string | null;
  expiresAt: number | null;
  username: string | null;
  email: string | null;
  groups: string[];
  hasAdminRole: boolean;
}

export function snapshotFromUser(
  user: User | null,
  adminGroup: string,
): SessionSnapshot {
  if (!user || user.expired) {
    return {
      idToken: null,
      accessToken: null,
      expiresAt: null,
      username: null,
      email: null,
      groups: [],
      hasAdminRole: false,
    };
  }
  const profile = user.profile as Record<string, unknown>;
  const groupsRaw = profile["cognito:groups"];
  const groups = Array.isArray(groupsRaw)
    ? groupsRaw.filter((g): g is string => typeof g === "string")
    : [];
  const email =
    typeof profile.email === "string" ? profile.email : null;
  const username =
    typeof profile["cognito:username"] === "string"
      ? (profile["cognito:username"] as string)
      : typeof profile.preferred_username === "string"
        ? (profile.preferred_username as string)
        : email;
  return {
    idToken: user.id_token ?? null,
    accessToken: user.access_token ?? null,
    expiresAt: user.expires_at ?? null,
    username,
    email,
    groups,
    hasAdminRole: groups.includes(adminGroup),
  };
}

export const ADMIN_GROUP = "admin";

export function createUserManager(opts: AuthOptions): UserManager {
  return new UserManager(buildManagerSettings(opts));
}
