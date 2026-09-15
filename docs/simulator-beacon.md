# Simulator beacon: technical design

The simulator beacon is an ordinary enrolled beacon (contracts 9) whose fixes come from a past year's recorded flight instead of a GPS. It runs on the fleet behind the gateway as a manifest service, replays the chosen year at a chosen speed through the hub with the HTTP fallback every beacon has, heartbeats every 15 s with its run state as its `debug` object, and is driven from a small control page on Vercel that signs in through the environment's admin pool. Register it in the panel like any beacon, activate it, set an event live, and the tracker shows a whole flight.

Every name, shape, path, and rule below is the one in the shared contracts (`docs/contracts.md`); where this document restates a contract it does so for the engineer's convenience and the contract wins on any difference. Choices this document makes are in section 12; choices that need the owner are in section 13.

---

## 1. Shape

| Piece | Choice |
|---|---|
| Server | Node 22, TypeScript strict, ES modules, `fastify` for the HTTP surface, `@microsoft/signalr` (WebSockets only, negotiation skipped), `pg` for the one-row state, `jose` for ID-token verification against the admin pool's JWKS, native `fetch` for the WMSFO API, `pino` logging (JSON lines) |
| Control page | `web/`: Vite, React 19, TypeScript, `oidc-client-ts` against the admin pool with the `wmsfo-simulator` client, hand-rolled CSS on the site's tokens (no UI library); one page |
| Data | One Postgres table in its own database `wmsfo_sim_<env>` (section 6); flights are read from the WMSFO API through an API key and cached in memory per year |
| Container | `node:22-alpine`, port 3000, `GET /api/health`; deployed exactly like the API (platform.md 3.6, 9.2a) |
| Tests | Vitest for the replay scheduler, the normalizer, the send-loop decision table, the token check; Playwright against the dev control page |
| Repository | `simulator-beacon`, branches `grunt`, `dev`, `main`; `contracts/` vendored with `CONTRACTS_SHA` and a contracts check (contracts 13) |

```
simulator-beacon/
  package.json  tsconfig.json  Dockerfile  .github/workflows/deploy.yml  .github/workflows/ci.yml
  CONTRACTS_SHA  contracts/  scripts/check-contracts.mjs
  docs/simulator-beacon.md  docs/DESIGN.md  docs/contracts.md  docs/README.md
  src/
    main.ts                     boot: config, database, leader monitor, worker, http
    config.ts                   the SIM_* keys, validated (section 7)
    beacon/                     the beacon core (contracts 9.2): identical in shape to legacy-beacon's
      socketLoop.ts  sendLoop.ts  heartbeatLoop.ts  backoff.ts  rest.ts  hub.ts  state.ts
    flights/
      api.ts                    GET /admin/events and /admin/events/{id}/locations through the API key
      cache.ts                  per-year point cache in memory, loaded on demand
      scheduler.ts              turns a recording plus a speed into timed fixes (section 4)
    control/
      auth.ts                   admin-pool ID token check (section 5)
      routes.ts                 GET /control/state, GET /control/years, POST /control/start, POST /control/stop, POST /control/restart
    leader.ts                   GET /internal/leader poll (contracts 7.5), 90 s expiry
    db.ts                       the sim_run row (section 6)
    health.ts                   GET /api/health
  web/
    index.html  vite.config.ts  vercel.json  src/main.tsx  src/App.tsx  src/auth.ts  src/api.ts  src/tokens.css  src/App.module.css
  tests/
```

---

## 2. What it does

1. Boots, verifies configuration, connects to its database, starts polling `GET /internal/leader` (every 2 s, 1 s timeout, leader only while the latest answer is `2xx`, `isLeader`, and `evaluatedAt` under 90 s old; `SIM_FORCE_LEADER=true` for local runs, refused in prod).
2. Every node serves `GET /api/health` and the control API (section 5). The control API writes the `sim_run` row; it never talks to the hub itself.
3. The leader runs the beacon core (section 3) and the worker loop (section 4): its tick is 250 ms so a control change lands within a quarter second; it reads the `sim_run` row on each tick (a single indexed select), loads the year's flight when a run starts, and feeds the scheduler's fixes to the send loop. `leader_state` and `leader_at` are written on every fourth tick (about once a second) and immediately after a status change the worker made; `index` is persisted every ten fixes as the resume point. A node that loses leadership stops its socket and its worker within one poll; the new leader picks the run up from the row so a hand-off skips at most a few points.
4. Heartbeats go every 15 s from the leader only (a follower has no socket and no run); `health.socketState` is the socket's state, `health.lastFixAgeS` the age of the last emitted fix, `health.batteryPercent` absent; `debug` is section 8.
5. A beacon never gives up: `main.ts` installs `process.on("unhandledRejection")` and `process.on("uncaughtException")` handlers that log at error and keep the process running. Every scheduler callback the worker registers is wrapped so an exception is logged (pino, level error, with the run's year and index) and never escapes.

Followers therefore look like nothing to the API; the beacon row shows one heartbeat stream and one socket, which is the point of leader gating.

---

## 3. The beacon core

`src/beacon/` implements contracts 9.2 in TypeScript, the same loops Red-Nose runs in Kotlin:

- `socketLoop.ts`: one `HubConnection` at a time (`withUrl(hubUrl, { skipNegotiation: true, transport: WebSockets })`, keep-alive 15 s, server timeout 30 s, no automatic reconnect: the loop owns it); `start()`, then `invoke("JoinPrivateChannel", ingestChannel, key)`; `connected` only on the `joined` ack for the ingest channel; `channelEvicted` with `auth_expired` re-joins immediately, `service_removed` retries the join every 5 s; a denied join waits 10 s; every other failure backs off 1 s, 2 s, 3 s, then 5 s forever; a close restarts the loop. The Node client's `invoke` resolves on the server's completion message for a void hub method, so no special overload is needed; the payload is passed as an object. The loop exposes `rejoin()` for the send loop's three-consecutive-hub-rejections trigger (below): every re-invocation increments `state.rejoinCount` and logs its outcome; on a throw the socket takes its close-or-failure branch so the send loop falls back to HTTP until the socket is `connected` again. Log lines: `socket: evicted <reason>`, `socket: rejoined`, `socket: rejoin failed <error>`.
- `sendLoop.ts`: one `latestFix` with `seqLocal`; at most one send in flight; `invoke("SendToChannel", ingestChannel, "location", payload)` while connected, else `POST /locations` with `X-Beacon-Key`; a rejected hub invoke is a failed send and never falls back while the socket is up; backoff on failure; `sendsFailedSinceBoot` counts only while `liveEventId` is non-null; a fix arriving mid-send replaces `latestFix` and goes out next. A `409 no_live_event` is a failed send like any other. **The HTTP window** (contracts 9.2): over HTTP a send starts no sooner than `HTTP_FALLBACK_INTERVAL_MS` (a constant 1000 in `sendLoop.ts`, overridable through `SendLoopOptions` for tests) after the previous HTTP send started; a fix arriving inside the window replaces `latestFix` and the newest goes out when the window ends; a socket that connects during the window takes the fix. The hub door has no window. **Three consecutive hub rejections while `socketState == connected` ask the socket loop to re-join once** via `socket.rejoin()` (the same path as `channelEvicted auth_expired`); the counter resets on any delivered send.
- `heartbeatLoop.ts`: every 15 s, `POST /beacons/heartbeat` over HTTP with `{ sentAt, health, debug }`; the answer's `liveEventId` and `isActive` land in state; `401` sets `revoked` and changes nothing else; skew from the request midpoint.
- `backoff.ts`: `[1000, 2000, 3000, 5000]`, the last repeats, reset on success, no maximum, no stopped state.
- `state.ts`: the `ServiceState` shape of red-nose.md 4.3 minus the phone-only fields, exposed to the control API's `GET /control/state` and to the heartbeat's `debug`.

Nothing is queued and nothing is persisted but the run row; the current fix is the only fix.

---

## 4. Flights and the scheduler

**Source.** `GET /admin/events` and `GET /admin/events/{id}/locations?publishedOnly=true&limit=500` (following `nextCursor`) on `SIM_API_BASE_URL` with `Authorization: Bearer <SIM_API_KEY>`, a `wak_` key minted in the panel with only the `events` capability. `GET /control/years` lists the years of events that have at least one published location (the six migrated years today, plus any real event later). A year's points are cached in memory for the life of the process and refreshed when a run starts for that year (a real event's recording grows until the event ends).

**Scheduler.** Input: the points in `seq` order with their `recordedAt`, and a speed `s` in `{ 1, 2, 5, 10, 20, 60 }`. Output: fix `i` is emitted `(recordedAt[i] - recordedAt[i-1]) / s` after fix `i-1`, clamped to at least 100 ms and at most 30 s (a gap in the recording does not stall the replay for an hour); the first fix goes out at once. Each emitted fix carries the point's `lat`, `lng`, `speedMps`, `altitudeM`, `headingDeg`, `accuracyM` as recorded (null stays null) and `recordedAt = now()`, because the API stores what the beacon says and the tracker shows the current position: a replay is a flight happening now. At the end of the recording the run stops (`status = "stopped"`, `index = total`); Restart begins again from the first point. Speed 1 is real time: the 2025 flight takes about two hours; speed 20 runs it in about six minutes. The 100 ms floor caps the effective speed: a recording spaced 250 ms apart plays at most 2.5 times faster than its own timing, while the legacy recordings at about 6.6 s apart reach the full 60x.

**The end, and changes while running.** When the last point has gone out the run starts again from the first point at once when `loop` is true (the default), adding one to `cycles`; when `loop` is false it stops (`stopped`, index kept at the last point). The worker compares the row with what it is running every tick (250 ms) and acts without a restart: a new `speed` re-times the next delay with the new speed and keeps the index; a new `year` stops the active run, loads the new year, and starts it from the first point; a new `loop` value applies at the next end.

**Stop and Start.** Stop keeps the row's `index` as before, so a subsequent Start with the same year and speed resumes the run from where it paused. Stop then Start is a pause and resume. `POST /control/start` keeps the row's `index` when the requested year equals the row's year and `0 <= index < total`; otherwise (a different year, `index == total` from a run that ended without loop, or an out-of-range `index`) it starts from 0. Restart is from 0 as before.

**Seek and peek.** `PATCH /control/run { index }` writes `seek_to` and `seek_at` on the row and answers the current state; the worker acts on it on the next tick and clears `seek_to` with `update sim_run set seek_to = null, index = $i where id = 1 and seek_to = $i` (the same value $i drives both the match and the index write). While running, the worker re-arms the scheduler at that index (`scheduler.start(index)` emits the point at once and continues at the run's speed) and resets `emittedSinceLastPersist`. While stopped (not loading, not failed) with a year on the row, the worker makes sure the year is loaded through the cache (loading marks nothing on the row), emits the single point at that index through `onEmit` with `recordedAt = now()` so the tracker shows that spot, and persists the row's `index`; status stays stopped so Start (above) resumes from there. While loading or failed the seek is cleared without effect. Several seeks in a row (a drag) leave the latest one standing: our conditional clear only matches when `seek_to` is still the value we acted on, so a newer value survives and the worker acts on it on the next tick. A peek uses the beacon core exactly like a running fix; nothing about the send loop changes.

**Run states.** `stopped` (nothing sent), `running` (fixes flowing), `loading` (points being fetched, a few seconds), `failed` (the API refused the flight: key revoked, year gone; the reason is in `lastError` and the row stays until the next start). The heartbeat keeps going in every state, so the beacon is healthy on the panel whether or not it is replaying; going live with it active and stopped shows the waiting-for-fix state on the tracker until Start is pressed.

---

## 5. The control surface

**Auth.** The control API accepts `Authorization: Bearer <id-token>` from the admin pool: `iss` is `SIM_COGNITO_ISSUER`, `aud` one of `SIM_COGNITO_CLIENT_IDS`, `token_use` `id`, signature from the pool's JWKS (`jose` `createRemoteJWKSet`, cached), `cognito:groups` contains `SIM_ADMIN_GROUP`. Anything else is `401` or `403` with the contracts' error shape. There is no TOTP check here; the pool's own sign-in with TOTP is what the page goes through. CORS for the exact origins in `SIM_CORS_ORIGINS`, methods `GET, POST`, header `Authorization, Content-Type`.

| Method and path | Body | Success | Errors |
|---|---|---|---|
| `GET /api/health` | | `200 { "status": "ok", "leader": bool }` | `503` before the row and the leader poll are ready |
| `GET /control/state` | | `200 { run: SimRun, beacon: { name, isActive, liveEventId, socketState, lastDeliveredSeqLocal, lastReceiptLatencyMs, heartbeatAge, revoked }, leaderInstance: string \| null }` (the beacon part is the leader's state, read from the row where the leader writes it about once a second; null fields when no leader has reported in 10 s). `run.index`, `run.cycles`, and `run.nextFixInMs` come from `leader_state.run` when `leaderAt` is within 10 s so the state follows the scheduler within a second; otherwise they fall back to the row (`nextFixInMs` is null) | |
| `GET /control/years` | | `200 { items: [ { year, eventId, name, pointCount } ] }` newest first | `502` when the WMSFO API refused |
| `GET /control/flight?year=YYYY` | | `200 { year, eventId, name, pointCount, firstRecordedAt, lastRecordedAt, durationMs, hasAltitude, speedSource, points: [ { i, t, lat, lng, speedMps, altitudeM } ] }`. `t` is milliseconds since the first point's `recordedAt`. `speedMps` is the recorded value when present, else derived: the haversine distance from the previous point divided by the seconds between the two `recordedAt` values (null for the first point and when the delta is not positive). `speedSource` is `"recorded"` when every non-null value was recorded, `"derived"` when every value was derived, `"mixed"` otherwise. `altitudeM` is the recorded value or null; `hasAltitude` is true when at least one point has one. The series is computed once per loaded year and kept with the cache entry. Every point is returned (the legacy years hold about 850 to 2,600 points; the page downsamples for drawing) | `400 validation_failed` (unknown year, non-integer year), `502 upstream_unavailable` (a cache load failure) |
| `POST /control/start` | `{ year, speed }` | `200 SimRun` (`status: "loading"`, then `running`). Keeps the row's `index` when the requested year equals the row's year and `0 <= index < total`, otherwise starts from 0 (a different year, `index == total` from a run that ended without loop, or out-of-range); Stop then Start therefore pauses and resumes | `400 validation_failed` (unknown year, speed not in the set), `409 already_running` |
| `POST /control/stop` | | `200 SimRun` (`stopped`, index kept) | |
| `POST /control/restart` | | `200 SimRun` (index 0, `running` with the current year and speed) | `409 no_run` |
| `PATCH /control/run` | `{ speed?, year?, loop?, index? }` (any subset) | `200 SimRun`: the row updated; while running the worker applies speed/year/loop within a quarter second (section 4: speed live, year from the first point, loop at the next end). `index` writes `seek_to` and `seek_at` on the row (section 4, seek and peek); the worker clamps to `total - 1` and acts on the next tick | `400 validation_failed` (unknown year, speed not in the set, non-integer or negative `index`), `409 no_run` (an `index` seek with no year on the row) |

```ts
type SimRun = { status: "stopped" | "loading" | "running" | "failed"; year: number | null; speed: number; loop: boolean; cycles: number; index: number; total: number;
                nextFixInMs: number | null; startedAt: string | null; lastFixAt: string | null; lastError: string | null; requestedBy: string | null; updatedAt: string };
```

**The page** (`web/`): sign in (one button, `signinRedirect` on the admin pool with the `wmsfo-simulator` client; the callback route; a "no role" line when the token has no `admin` group), then one card: the beacon line (name, Active or Spare, live event or "no live event", socket state, last delivered, receipt latency, heartbeat age, a red Revoked banner when set), the run line (status, year, speed, `index / total`, elapsed since `startedAt`, `run.nextFixInMs` when present), a timeline of the selected year, a year select from `GET /control/years`, a speed select (1x, 2x, 5x, 10x, 20x, 60x), a Loop switch, and Start (which reads "Resume" when the run is stopped mid-recording for the selected year, "Start" otherwise), Pause (the Stop button), Restart. The selects and the switch are never disabled: while a run is going, a change sends `PATCH /control/run` at once and the state line shows it take effect (the run line adds "cycle n" when `cycles` is above zero); while stopped the choice is what Start will use. The selects seed once from the row and keep the operator's choice across polls. The page polls `GET /control/state` every second while visible. **The timeline** (`Timeline.tsx`, an inline SVG that fills the card, about 200 px tall, plus a readout row): x is elapsed time from 0 to `durationMs` with ticks every 15 minutes labelled `h:mm`; the left y axis is speed in mph (`speedMps × 2.23694`) with round ticks and the legend `mph` (or `mph (derived)` when `speedSource == "derived"`); the right y axis is altitude in feet (`altitudeM × 3.28084`) with the legend `ft` when `hasAltitude`, otherwise no right axis and the legend reads `no altitude in this recording`. Two polylines (speed in the accent colour, altitude muted) are downsampled to at most one bucket per pixel column, keeping the bucket's min and max so a spike survives. A muted band marks the fastest 10 percent of points. A vertical playhead with a small handle follows `run.index` whenever `run.year` equals the selected year and the run has a total; hovering the chart shows a thin hover line and fills the readout row (`h:mm:ss`, mph, ft or `— ft`, `point n of N`). Pointer down starts a drag: the playhead follows the pointer, the readout tracks it, and `PATCH /control/run { index }` is sent at most every 200 ms while dragging (trailing) and once more on release; a click without movement seeks once. With the chart focused (`tabIndex 0`, `role slider`, `aria-valuenow` the index, `aria-valuemax` `total - 1`), ArrowLeft and ArrowRight step one point, Shift+arrow steps ten, Home and End go to the ends, each sending one PATCH. Touch works through pointer events (`touch-action: none`). The flight for the selected year comes from `GET /control/flight` fetched once on load and on every year change, kept per-year in memory; a failure shows on the error line and the chart area reads `no flight loaded`. Styling: the site's token file copied (`tokens.css`, dark and light by `prefers-color-scheme`), Plex Sans and Mono, one frost card; no UI library, no chart library. Environment: `VITE_SIM_API_BASE_URL`, `VITE_COGNITO_AUTHORITY`, `VITE_COGNITO_DOMAIN`, `VITE_COGNITO_CLIENT_ID`; a missing value renders the configuration page. Local runs on `http://localhost:5175`.

---

## 6. State

Database `wmsfo_sim_<env>` on the shared instance, roles `wmsfo_sim_migrate_<env>` (owner) and `wmsfo_sim_app_<env>` (DML), created like sql.md 12 with the `wmsfo_sim_` prefix. One table, created by the app on boot when missing (there is nothing to migrate):

```sql
create table sim_run (
  id            smallint primary key check (id = 1),
  status        text not null default 'stopped' check (status in ('stopped', 'loading', 'running', 'failed')),
  year          integer,
  speed         integer not null default 1,
  loop          boolean not null default true,
  cycles        integer not null default 0,
  index         integer not null default 0,
  total         integer not null default 0,
  started_at    timestamptz,
  last_fix_at   timestamptz,
  last_error    text,
  requested_by  text,
  leader_state  jsonb,                      -- the leader's beacon state, written every second for GET /control/state
  leader_at     timestamptz,
  updated_at    timestamptz not null default now()
);
insert into sim_run (id) values (1) on conflict do nothing;
```

The boot also runs `alter table sim_run add column if not exists` for `loop`, `cycles`, `seek_to integer`, and `seek_at timestamptz`, so an existing row gains them. The control API updates `status`, `year`, `speed`, `loop`, `index`, `requested_by`, and writes `seek_to`/`seek_at` for a `PATCH /control/run { index }` request; the leader reads the row every second, acts on a change (including a queued seek), and writes `index` every ten fixes plus `leader_state` and `leader_at` every second, and clears `seek_to` with `update sim_run set seek_to = null, index = $i where id = 1 and seek_to = $i` after it acts on the request. Read committed; one row; no locks needed beyond `update ... where id = 1`.

`SIM_DB_CONNECTION` is a libpq URI. `db.ts` parses it with `pg-connection-string` and builds the pool from the explicit `host`, `port`, `user`, `password`, `database` fields (not from `{ connectionString }`; pg parses the URI last and its `ssl` for `sslmode=verify-full` is `{}`, which would replace our `{ ca }` object and drop the RDS trust chain). `sslmode` picks the TLS shape: `verify-full` and `verify-ca` get `ssl: { ca, rejectUnauthorized: true }` with the CA read from `RDS_CA_PATH` (`/etc/ssl/certs/rds-global-bundle.pem`, overridable in tests via `caPath`); `disable` gets `ssl: false`; `require`, `prefer`, and an absent `sslmode` get `ssl: { rejectUnauthorized: false }`. If the CA file is missing under `verify-full` or `verify-ca` the boot fails with a message naming the sslmode and the path ; no silent fallback to an unverified chain. `pg` is CommonJS, so `db.ts` imports it as `import pg from "pg"` and destructures `Pool` off the default; the named-import form dies at load under Node ESM ("does not provide an export named 'Pool'"), which Vitest's interop hides.

---

## 7. Configuration

Flat JSON secret per environment (platform.md 3.6), every key required unless marked:

| Key | Value |
|---|---|
| `SIM_ENV` | `dev` or `prod` |
| `SIM_API_BASE_URL` | the WMSFO API, `https://<api-domain>` |
| `SIM_API_KEY` | a `wak_` key with the `events` capability, minted in the panel and named `simulator` |
| `SIM_BEACON_KEY` | the `wbk_` key of the beacon named `simulator`, minted in the panel |
| `SIM_HUB_URL`, `SIM_INGEST_CHANNEL` | `wss://<gateway-domain>/hub`, `<service>:ingest` (as `GET /beacons/me` reports; the app also verifies them against that call at boot and logs a mismatch) |
| `SIM_GATEWAY_INTERNAL_URL` | `http://<docker-bridge-ip>:8080` |
| `SIM_DB_CONNECTION` | a libpq URI, `postgresql://wmsfo_sim_app_<env>:<password>@<db-host>:5432/wmsfo_sim_<env>?sslmode=verify-full`; the image carries the RDS global certificate bundle at `/etc/ssl/certs/rds-global-bundle.pem` and `db.ts` passes it as the `ssl.ca` of the `pg` pool, so the server certificate is verified like the API does |
| `SIM_COGNITO_ISSUER`, `SIM_COGNITO_CLIENT_IDS`, `SIM_ADMIN_GROUP` | the admin pool, `wmsfo-simulator`, `admin` |
| `SIM_CORS_ORIGINS` | the control page origins, exact |
| `SIM_LOG_LEVEL` | `info` |
| `SIM_FORCE_LEADER` (optional) | local only, refused in prod |
| `GATEWAY_REALTIME_TOKEN` | injected by the gateway; used only for `/internal/leader` |

The app fails fast on a missing key, printing the key name and never the value.

---

## 8. The heartbeat's debug object

```json
{
  "run": { "status": "running", "year": 2025, "speed": 20, "index": 412, "total": 1065, "startedAt": "...", "lastFixAt": "...", "nextFixInMs": 340 },
  "source": { "apiBaseUrl": "...", "cachedYears": [2025], "lastFlightLoadMs": 812, "lastFlightLoadAt": "..." },
  "transport": { "socketState": "connected", "reconnectCount": 0, "rejoinCount": 0, "httpFallbackSeconds": 0, "lastReceiptLatencyMs": 96, "sendsFailedSinceBoot": 0 },
  "process": { "uptimeS": 3600, "leader": true, "instance": "i-...", "version": "0.1.0", "node": "v22.x" }
}
```

The panel renders it as a tree; nothing in it is read by anything.

---

## 9. Deployment

Manifest entry `simulator-beacon` (`-dev`), image `simulator-beacon:<sha>-<env>`, port 3000, secret per section 7, `includeInHealth` true, no realtime fields (platform.md 3.6). CI per platform.md 9.2a. `.github/workflows/deploy.yml` is the API's workflow with the names changed: a test job (`npm ci`, contracts check, typecheck, test, build; the web is built by Vercel, not here) and a deploy job gated on `push` to `dev` that assumes the OIDC role, logs into ECR, sets up QEMU and buildx, pushes a multi-platform image tagged `<ECR_REPOSITORY>:<sha>-<env>`, obtains a `mgmt/deploy` token, calls the gateway's deploy, and waits up to ten minutes for `done`. The dev environment carries the same secrets as the legacy beacon's (`AWS_ROLE_ARN`, `ECR_REPOSITORY`, `GATEWAY_BASE_URL`, `GATEWAY_TOKEN_URL`, `GATEWAY_CLIENT_ID`, `GATEWAY_CLIENT_SECRET`, `GATEWAY_SERVICE_NAME`) plus the variable `AWS_REGION`. The control page is a Vercel project on `web/` (platform.md 8) at `<simulator-domain>` and `<simulator-dev-domain>`; its API base URL is the gateway path form `https://<gateway-domain>/simulator-beacon-dev` (an operator tool needs no host of its own). First run per environment: mint the API key and the beacon in the panel, write the secret, upsert the manifest entry from the dashboard, deploy, enrol nothing (the beacon key is in the secret), activate the beacon when a replay should reach the tracker.

---

## 10. Local development

`docker compose up` starts Postgres with the two roles and the database; `.env.local` carries the dev keys with `SIM_FORCE_LEADER=true` and `SIM_GATEWAY_INTERNAL_URL=http://localhost:1`; the beacon and API keys point at the dev API, so a local run replays into dev exactly as the fleet would (activate the local beacon in the panel, or leave it a spare to watch the stored-but-unpublished rows). `web/` runs on 5175 against the local server.

---

## 11. Tests

| Suite | Covers |
|---|---|
| `scheduler` | inter-point delays divided by speed, the 100 ms floor and 30 s ceiling, the first fix immediate, loop at the end (cycles counted) or stop when loop is off, a speed change re-timing the next delay without a restart, a year change restarting from the first point, restart from zero, `recordedAt` is now |
| `worker` | Stop pressed during the end-of-run await does not throw and the row ends stopped (a fake db whose `update` resolves after the stop); `leader_state.run` carries the live index and cycles after a loop restart; the 250 ms tick cadence with fake timers; the Start-resume rule in `controlRoutes`; seek while running re-arms the scheduler at the index and emits at once, seek while stopped emits exactly one point and stays stopped, the latest of three quick seeks wins, seek while failed is cleared without an emit |
| `flightRoute` | a three-point fixture with null recorded speeds derives the two speeds to within 1% of hand-computed haversine values, recorded speeds pass through, `hasAltitude` is false when every altitude is null, an unknown year 400, a cache load failure 502 |
| `beacon/sendLoop` | the decision table of contracts 9.2 with a fake hub and fake REST: delivered, rejected on the hub never falls back, HTTP when disconnected, mid-send replacement, `sendsFailedSinceBoot` only with a live event; the HTTP window (three fixes in one second over HTTP produce one POST carrying the newest; a socket that connects during the window takes the fix); three consecutive hub rejections trigger one `onHubRejectionThreshold` and the counter resets on a delivered send |
| `beacon/socketLoop` | `connected` only on `joined`, eviction re-join, denied join waits 10 s, close restarts, backoff sequence; three rejections trigger one `rejoin()`; a throwing rejoin takes the failure branch (`socketState = reconnecting`, `rejoinCount` incremented on every re-invocation); the counter resets on success |
| `beacon/heartbeat` | body shape validates against the vendored `heartbeat.schema.json`; `401` sets revoked; skew formula |
| `flights/api` | paging follows `nextCursor`; `publishedOnly`; a `401` from the API marks the run failed with the code |
| `control/auth` | issuer, audience, `token_use`, group, expiry, a people-pool token refused |
| `control/routes` | every code in section 5 against a fake row; the Start-resume rule (same year keeps the row's `index` when in range, otherwise 0; `index == total` starts from 0); `GET /control/state` reads `run.index`, `run.cycles`, and `run.nextFixInMs` from `leader_state.run` when fresh, else from the row; `PATCH /control/run { index }` writes `seek_to`/`seek_at` and returns the state body, 409 no_run without a year on the row, 400 for a non-integer or negative `index` |
| `leader` | 90 s expiry, follower on any failure, force flag refused in prod |
| `timelineMath` and `Timeline` | `indexToX` and `xToIndex` round-trip within one point across the width; downsampling keeps the max of a bucket so a spike survives; hover fills the readout row; a drag of three pointer moves inside 200 ms sends one trailing `PATCH /control/run { index }` plus one on release with the released index; ArrowRight sends `index + 1` and Shift+ArrowRight `index + 10`; Home and End go to the ends; the empty-flight fallback reads `no flight loaded`; the button labels flip per the rule (Resume when stopped mid-recording for the selected year, Start otherwise; Pause always) |
| `ControlPanel` (flight fetch) | fetches `GET /control/flight` on load and on every year change; a fetch failure shows the message on the error line and the chart reads `no flight loaded` |
| Playwright (dev) | sign in through the admin pool, pick 2025 at 60x, Start, the state shows `running` with a rising index, the dev CDN `live/location.json` moves within 5 s while the dev event is live and this beacon is active, Stop; a second spec drags the playhead to the middle of the chart and expects `run.index` within 5% of half the total inside 2 s, then Pause and expects the status stopped with the index kept |

---

## 12. Decisions made here

- The simulator is a fleet service gated on `/internal/leader`, not a single container, so it deploys like everything else; its shared state is one Postgres row in its own database.
- Flights come from the WMSFO API through an `events`-capability API key, never from the database or the CDN, so the simulator works unchanged against prod later.
- Replay preserves the recording's timing divided by the chosen speed, clamped to 100 ms and 30 s; `recordedAt` is the send time; a run stops at the end and restarts from the first point.
- The control page signs in through the admin pool with its own client and requires the `admin` group; the server checks the ID token itself and never calls the WMSFO API on the operator's behalf.
- One page, no UI library, the site's tokens copied in.
- The beacon core is written to contracts 9.2 in TypeScript and copied verbatim into the legacy beacon; the two stay identical by hand.
- A run loops by default and every control applies while it runs; the row is the only source of truth and the worker follows it every second.
- A seek is a row column (`seek_to`) the worker clears on the next tick, not an in-process call, so it works on whichever node took the request; the leader on the other node reads `seek_to` on its 250 ms tick and acts.

## 13. Needs a decision

Nothing at the moment. Add here as it comes up.
