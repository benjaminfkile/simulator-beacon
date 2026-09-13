import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { UserManager, type User } from "oidc-client-ts";
import styles from "./App.module.css";
import { loadWebConfig } from "./config.js";
import { ADMIN_GROUP, createUserManager, snapshotFromUser, type SessionSnapshot } from "./auth.js";
import { ApiError, createApiClient, type ApiClient } from "./api.js";
import type { ControlState, YearItem, Speed } from "./types.js";
import { ConfigurationNotice } from "./ConfigurationNotice.js";
import { StateCard } from "./StateCard.js";

type Route = "home" | "callback";

function routeFromLocation(): Route {
  return typeof window !== "undefined" &&
    window.location.pathname === "/auth/callback"
    ? "callback"
    : "home";
}

interface BootResult {
  user: User | null;
  error: string | null;
  redirected: boolean;
}

export function App() {
  const configResult = useMemo(() => loadWebConfig(), []);
  if (!configResult.ok) {
    return <ConfigurationNotice missing={configResult.missing} />;
  }
  return <SignedApp />;
}

function SignedApp() {
  const configResult = useMemo(() => loadWebConfig(), []);
  const config = configResult.config!;
  const origin = window.location.origin;
  const managerRef = useRef<UserManager | null>(null);
  if (!managerRef.current) {
    managerRef.current = createUserManager({ config, origin });
  }
  const manager = managerRef.current;

  const [route, setRoute] = useState<Route>(routeFromLocation);
  const [session, setSession] = useState<SessionSnapshot>(() =>
    snapshotFromUser(null, ADMIN_GROUP),
  );
  const [authReady, setAuthReady] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string | null>(null);
  // Boot readiness comes from a shared promise so StrictMode's double-invoke
  // cannot swallow it: the first call starts the work, the second awaits the
  // same promise. signinRedirectCallback runs at most once — the pool would
  // reject a second attempt at the same auth code.
  const bootPromiseRef = useRef<Promise<BootResult> | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!bootPromiseRef.current) {
      bootPromiseRef.current = (async (): Promise<BootResult> => {
        try {
          if (routeFromLocation() === "callback") {
            const user = await manager.signinRedirectCallback();
            return { user, error: null, redirected: true };
          }
          const user = await manager.getUser();
          return { user, error: null, redirected: false };
        } catch (err) {
          return {
            user: null,
            error: err instanceof Error ? err.message : String(err),
            redirected: false,
          };
        }
      })();
    }
    void bootPromiseRef.current.then((result) => {
      if (cancelled) return;
      if (result.error !== null) {
        setAuthError(result.error);
      } else {
        setSession(snapshotFromUser(result.user, ADMIN_GROUP));
      }
      if (result.redirected) {
        window.history.replaceState({}, "", "/");
        setRoute("home");
      }
      setAuthReady(true);
    });
    const onLoaded = (user: User): void => {
      setSession(snapshotFromUser(user, ADMIN_GROUP));
    };
    const onUnloaded = (): void => {
      setSession(snapshotFromUser(null, ADMIN_GROUP));
    };
    manager.events.addUserLoaded(onLoaded);
    manager.events.addUserUnloaded(onUnloaded);
    return () => {
      cancelled = true;
      manager.events.removeUserLoaded(onLoaded);
      manager.events.removeUserUnloaded(onUnloaded);
    };
  }, [manager, route]);

  const idTokenRef = useRef<string | null>(null);
  idTokenRef.current = session.idToken;
  const api = useMemo<ApiClient>(
    () =>
      createApiClient({
        baseUrl: config.apiBaseUrl,
        getIdToken: () => idTokenRef.current,
      }),
    [config.apiBaseUrl],
  );

  const signIn = useCallback((): void => {
    void manager.signinRedirect();
  }, [manager]);

  const signOut = useCallback((): void => {
    void manager.signoutRedirect();
  }, [manager]);

  if (!authReady) {
    return (
      <div className={styles.app}>
        <div className={styles.card}>Loading…</div>
      </div>
    );
  }

  if (authError) {
    return (
      <div className={styles.app}>
        <div className={styles.card}>
          <p className={styles.errorLine}>Auth error: {authError}</p>
          <div className={styles.buttons}>
            <button className={styles.button} onClick={signIn}>
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!session.idToken) {
    return (
      <div className={styles.app}>
        <div className={`${styles.card} ${styles.signInWrap}`}>
          <h1 className={styles.title}>Simulator beacon control</h1>
          <p style={{ margin: 0, color: "var(--color-ink-muted)" }}>
            Sign in with your admin account to control the simulator.
          </p>
          <button
            className={`${styles.button} ${styles.buttonPrimary}`}
            onClick={signIn}
          >
            Sign in
          </button>
        </div>
      </div>
    );
  }

  if (!session.hasAdminRole) {
    return (
      <div className={styles.app}>
        <div className={`${styles.card} ${styles.signInWrap}`}>
          <h1 className={styles.title}>Simulator beacon control</h1>
          <p className={styles.noRoleLine}>
            Your account does not have the admin role. Ask an operator to add
            you to the <code>admin</code> group.
          </p>
          <div className={styles.buttons}>
            <button className={styles.button} onClick={signOut}>
              Sign out
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <h1 className={styles.title}>Simulator beacon control</h1>
        <span className={styles.identity}>
          <span>{session.email ?? "signed in"}</span>
          <button className={styles.button} onClick={signOut}>
            Sign out
          </button>
        </span>
      </header>
      <ControlPanel api={api} />
    </div>
  );
}

interface ControlPanelProps {
  api: ApiClient;
}

const SPEED_OPTIONS: readonly Speed[] = [1, 2, 5, 10, 20, 60] as const;

function ControlPanel(props: ControlPanelProps) {
  const { api } = props;
  const [state, setState] = useState<ControlState | null>(null);
  const [years, setYears] = useState<YearItem[]>([]);
  const [selectedYear, setSelectedYear] = useState<number | "">("");
  const [selectedSpeed, setSelectedSpeed] = useState<Speed>(1);
  const [errorLine, setErrorLine] = useState<string | null>(null);
  const [busy, setBusy] = useState<"" | "start" | "stop" | "restart">("");

  const refreshState = useCallback(async (): Promise<void> => {
    try {
      const next = await api.getState();
      setState(next);
      if (selectedYear === "" && next.run.year != null) setSelectedYear(next.run.year);
      if (
        next.run.speed != null &&
        (SPEED_OPTIONS as readonly number[]).includes(next.run.speed)
      ) {
        setSelectedSpeed(next.run.speed as Speed);
      }
    } catch (err) {
      // Polling errors are shown once but not stacked — they auto-clear on the
      // next successful poll.
      if (err instanceof ApiError) {
        setErrorLine(err.message);
      } else {
        setErrorLine(err instanceof Error ? err.message : String(err));
      }
    }
    // We intentionally exclude selectedYear from deps so the poll does not
    // re-arm on every change; the effect below owns the interval lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    async function loadYears(): Promise<void> {
      try {
        const res = await api.getYears();
        if (cancelled) return;
        setYears(res.items);
        if (res.items.length > 0 && selectedYear === "") {
          setSelectedYear(res.items[0]!.year);
        }
      } catch (err) {
        if (cancelled) return;
        setErrorLine(err instanceof Error ? err.message : String(err));
      }
    }
    void loadYears();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  // Poll GET /control/state every second while the page is visible
  // (simulator-beacon.md 5).
  useEffect(() => {
    let cancelled = false;
    let handle: ReturnType<typeof setInterval> | null = null;
    async function tick(): Promise<void> {
      if (cancelled) return;
      if (document.visibilityState !== "visible") return;
      await refreshState();
    }
    void tick();
    handle = setInterval(() => {
      void tick();
    }, 1000);
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      if (handle) clearInterval(handle);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshState]);

  const onStart = useCallback(async (): Promise<void> => {
    if (selectedYear === "") return;
    setErrorLine(null);
    setBusy("start");
    try {
      const next = await api.start({ year: selectedYear, speed: selectedSpeed });
      setState(next);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrorLine(err.message);
      } else {
        setErrorLine(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy("");
    }
  }, [api, selectedYear, selectedSpeed]);

  const onStop = useCallback(async (): Promise<void> => {
    setErrorLine(null);
    setBusy("stop");
    try {
      const next = await api.stop();
      setState(next);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrorLine(err.message);
      } else {
        setErrorLine(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy("");
    }
  }, [api]);

  const onRestart = useCallback(async (): Promise<void> => {
    setErrorLine(null);
    setBusy("restart");
    try {
      const next = await api.restart();
      setState(next);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrorLine(err.message);
      } else {
        setErrorLine(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy("");
    }
  }, [api]);

  return (
    <StateCard
      state={state}
      years={years}
      selectedYear={selectedYear}
      selectedSpeed={selectedSpeed}
      onYearChange={setSelectedYear}
      onSpeedChange={setSelectedSpeed}
      onStart={onStart}
      onStop={onStop}
      onRestart={onRestart}
      errorLine={errorLine}
      busy={busy}
      speedOptions={SPEED_OPTIONS}
    />
  );
}
