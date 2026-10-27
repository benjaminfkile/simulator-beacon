# Simulator beacon: technical design

The simulator beacon is an ordinary enrolled beacon (contracts 9) whose fixes come from a past year's recorded flight instead of a GPS. It runs on the fleet behind the gateway as a manifest service, replays the chosen year at a chosen speed through the hub with the HTTP fallback every beacon has, heartbeats every 15 s with its run state as its `debug` object, and is driven from a small control page on Vercel that signs in through the environment's admin pool. Register it in the panel like any beacon, activate it, set an event live, and the tracker shows a whole flight.

Every name, shape, path, and rule below is the one in the shared contracts (`docs/contracts.md`); where this document restates a contract it does so for the engineer's convenience and the contract wins on any difference. Choices this document makes are in section 12; choices that need the owner are in section 13.

---

## 1. Shape

| Piece | Choice |
|---|---|
| Server | Node 22, TypeScript strict, ES modules, `fastify` for the HTTP surface, `beacon-library` for the beacon core (the socket loop, the send loop, the heartbeat loop, the REST client, the leader monitor, and the state store that reads and writes the beacon's state document), no database, `jose` for ID-token verification against the admin pool's JWKS, native `fetch` for the WMSFO API, `pino` logging (JSON lines) |
| Control page | `web/`: Vite, React 19, TypeScript, `oidc-client-ts` against the admin pool with the `wmsfo-simulator` client, hand-rolled CSS on the site's tokens (no UI library); one page |
| Data | The run lives in this beacon's state document, which the WMSFO API keeps per beacon (contracts 4.2 and 9.5) and `beacon-library` reads and writes (section 6); there is no database. Flights are read from the WMSFO API through an API key and cached in memory per year |
| Container | `node:22-alpine`, port 3000, `GET /api/health`; deployed exactly like the API (platform.md 3.6, 9.2a) |
| Tests | Vitest for the replay scheduler, the normalizer, the send-loop decision table, the token check; Playwright against the dev control page |
| Repository | `simulator-beacon`, branches `grunt`, `dev`, `main`; `contracts/` vendored with `CONTRACTS_SHA` and a contracts check (contracts 13) |

```
simulator-beacon/
  package.json  tsconfig.json  tsconfig.build.json  vitest.config.ts  Dockerfile  .github/workflows/deploy.yml  .github/workflows/ci.yml
  CONTRACTS_SHA  contracts/  scripts/check-contracts.mjs
  BEACON_LIBRARY_SHA  vendor/  scripts/check-beacon-library.mjs
  docs/simulator-beacon.md  docs/DESIGN.md  docs/contracts.md  docs/README.md
  src/
    main.ts                     boot: loads configuration, hands it to startService, wires SIGTERM and SIGINT
    service.ts                  the wiring: the beacon-library core, the state store over its REST client, control server, gateOnLeader, worker (listens on 3000)
    worker.ts                   the leader-only loop: reads the run on a 250 ms tick, feeds the scheduler's fixes into the beacon core, persists progress (sections 2 and 4)
    config.ts                   the SIM_* keys, validated (section 7)
    flights/
      api.ts                    GET /admin/events and /admin/events/{id}/locations through the API key
      cache.ts                  per-year point cache in memory, loaded on demand
      scheduler.ts              turns a recording plus a speed into timed fixes (section 4)
      series.ts                 the flight series behind GET /control/flight: speed and altitude against time, the index the seek writes
    control/
      auth.ts                   admin-pool ID token check (section 5)
      routes.ts                 GET /api/health and the control routes of section 5 (state, years, flight, start, stop, restart, PATCH run)
    runStore.ts                 the SimRun and Db types the worker and the control routes use (section 6)
    stateDb.ts                  createStateDb: Db over the beacon's state document (section 6)
  web/
    index.html  vite.config.ts  vercel.json  playwright.config.ts  e2e/
    src/main.tsx  App.tsx  config.ts (the VITE_ values, validated)  ConfigurationNotice.tsx  auth.ts  api.ts  types.ts
    src/StateCard.tsx  Timeline.tsx  timelineMath.ts  tokens.css  App.module.css
  tests/
```

---

## 2. What it does

1. Boots, verifies configuration, reads the beacon's state document (writing the default run when it has none, section 6), starts polling `GET /internal/leader` (every 2 s, 1 s timeout, leader only while the latest answer is `2xx`, `isLeader`, and `evaluatedAt` under 90 s old; `SIM_FORCE_LEADER=true` for local runs, refused in prod).
2. Every node serves `GET /api/health` and the control API (section 5). The control API writes the run in the beacon's state document; it never talks to the hub itself.
3. The leader runs the beacon core (section 3) and the worker loop (section 4): its tick is 250 ms so a control change lands within a quarter second; it reads the run on each tick from its node's copy of the document (reloaded when older than 250 ms), loads the year's flight when a run starts, and feeds the scheduler's fixes to the send loop. The leader state (`leader`) is written on every fourth tick (about once a second) and immediately after a status change the worker made, and the same write carries the run's `index` (the resume point) and `lastFixAt`. A node that loses leadership stops its socket and its worker within one poll; the new leader picks the run up from the document, so a hand-off resumes within about a second of the last fix.

Leader and followers share the run through the document and nothing else. Each node holds one copy of it in its state store; a follower serving `GET /control/state` answers from that copy (reloaded when older than 250 ms), and a control route on any node writes through the store's version check. When two writes land together (a control route on a follower and the leader's once-a-second write), one meets `409 state_version_conflict`, rereads, applies its change to the fresh document, and writes again, so both survive.
4. Heartbeats go every 15 s from the leader only (a follower has no socket and no run); `health.socketState` is the socket's state, `health.lastFixAgeS` the age of the last emitted fix, `health.batteryPercent` absent; `debug` is section 8.
5. A beacon never gives up: `main.ts` installs `process.on("unhandledRejection")` and `process.on("uncaughtException")` handlers that log at error and keep the process running. Every scheduler callback the worker registers is wrapped so an exception is logged (pino, level error, with the run's year and index) and never escapes.

Followers therefore look like nothing to the API; the beacon row shows one heartbeat stream and one socket, which is the point of leader gating.

---

## 3. The beacon core

The core is the `beacon-library` package (contracts 9.2), vendored at the version in `package.json`. The service imports `createBeacon` and `gateOnLeader` from it; the socket loop, the send loop, the heartbeat loop, the REST client, the leader monitor, and the state shape are all in the library and are shared with the other Node beacons on the fleet. What is particular to the simulator lives in this repository:

- `service.ts` builds the beacon with the SIM_* configuration and hands it a `buildHealth` and a `buildDebug` that assemble the objects the heartbeat carries (`health.socketState`, `health.lastFixAgeS`, `health.batteryPercent` null; `debug` is section 8 below).
- `gateOnLeader` runs the beacon on the leader only: `onStart` starts the worker of section 4 and `onStop` stops it. Every fix the worker emits calls `setLatestFix(beacon.state, ...)` and then `beacon.wake()` so the send loop takes it on its next tick.
- The control API's `GET /control/state` and the health probe read the beacon's state (`beacon.state`) and the returned `Leader`; the worker writes the same state into the document's `leader` every second so a follower can serve `GET /control/state`.

Nothing is queued and nothing is persisted but the state document; the current fix is the only fix.

---

## 4. Flights and the scheduler

**Source.** `GET /admin/events` and `GET /admin/events/{id}/locations?publishedOnly=true&limit=500` (following `nextCursor`) on `SIM_API_BASE_URL` with `Authorization: Bearer <SIM_API_KEY>`, a `wak_` key minted in the panel with only the `events` capability. `GET /control/years` lists the years of events that have at least one published location (the six migrated years today, plus any real event later). A year's points are cached in memory for the life of the process and refreshed when a run starts for that year (a real event's recording grows until the event ends). Any event listing (a refresh of the cache, a load, or the year check below) that no longer holds a year drops that year from the cache, so `GET /control/years` stops listing it.

**Scheduler.** Input: the points in `seq` order with their `recordedAt`, and a speed `s` in `{ 1, 2, 5, 10, 20, 60 }`. Output: fix `i` is emitted `(recordedAt[i] - recordedAt[i-1]) / s` after fix `i-1`, clamped to at least 100 ms and at most 30 s (a gap in the recording does not stall the replay for an hour); the first fix goes out at once. Each emitted fix carries the point's `lat`, `lng`, `altitudeM`, `accuracyM` as recorded (null stays null), its `headingDeg` and `speedMps`, and `recordedAt = now()`. The `headingDeg` is the recording's value when it has one, else the course derived once at load (`flights/fill.ts`, applied by the cache) as the initial bearing from the nearest earlier point at least 15 m back, else the course to the nearest later point at least 15 m ahead, else null (a recording that never moves 15 m). The `speedMps` is the recording's value when it has one, else the recording's own speed derived at the same load, the haversine distance from the previous point over the seconds between the two `recordedAt` values rounded to 0.1 m/s (the first point from the segment ahead), else null (no segment, or a time delta that is not positive). The speed is not scaled by the replay speed: the beacon reports what the flight did, the replay speed is the operator's fast-forward, and the site only displays the value. The API derives a heading and a speed only when it stores a fix, and a looped replay carries every fix after the first lap, so the beacon reports its own, as a real one does; the API's rules stand for fixes without them. The `recordedAt` is now, because the API stores what the beacon says and the tracker shows the current position: a replay is a flight happening now. At the end of the recording the run stops (`status = "stopped"`, `index = total`); Restart begins again from the first point. While a run is going, the run's `index` (the next point to send) and `lastFixAt` are written with the leader state about once a second (section 2), so a new leader resumes within about a second of the last fix. Speed 1 is real time: the 2025 flight takes about two hours; speed 20 runs it in about six minutes. The 100 ms floor caps the effective speed: a recording spaced 250 ms apart plays at most 2.5 times faster than its own timing, while the legacy recordings at about 6.6 s apart reach the full 60x.

**The end, and changes while running.** When the last point has gone out the run starts again from the first point at once when `loop` is true (the default), adding one to `cycles`; when `loop` is false it stops (`stopped`, index kept at the last point). The worker compares the run with what it is running every tick (250 ms) and acts without a restart: a new `speed` re-times the next delay with the new speed and keeps the index; a new `year` stops the active run, loads the new year, and starts it from the first point; a new `loop` value applies at the next end.

**Stop and Start.** Stop keeps the run's `index` as before, so a subsequent Start with the same year and speed resumes the run from where it paused. Stop then Start is a pause and resume. `POST /control/start` keeps the run's `index` when the requested year equals the run's year and `0 <= index < total`; otherwise (a different year, `index == total` from a run that ended without loop, or an out-of-range `index`) it starts from 0. Restart is from 0 as before.

**Seek and peek.** `PATCH /control/run { index }` writes `seekTo` and `seekAt` on the run and answers the current state; the worker acts on it on the next tick and clears `seekTo` with a conditional write that sets `seekTo` to null and `index` to `i` only when `seekTo` is still `i` (the same value drives both the match and the index write; the document's version check makes the condition and the write one step, section 6). While running, the worker re-arms the scheduler at that index (`scheduler.start(index)` emits the point at once and continues at the run's speed). While stopped (not loading, not failed) with a year on the run, the worker makes sure the year is loaded through the cache (loading marks nothing on the run), emits the single point at that index through `onEmit` with `recordedAt = now()` so the tracker shows that spot, and persists the run's `index`; status stays stopped so Start (above) resumes from there. While loading the seek waits on the run and the first running tick applies it, so a drag right after Start lands; while failed it is cleared without effect. Several seeks in a row (a drag) leave the latest one standing: the conditional clear only matches when `seekTo` is still the value we acted on, so a newer value survives and the worker acts on it on the next tick. A peek uses the beacon core exactly like a running fix; nothing about the send loop changes.

**Run states.** `stopped` (nothing sent), `running` (fixes flowing), `loading` (points being fetched, a few seconds), `failed` (the API refused the flight: key revoked, year gone; the reason is in `lastError` and the run stays until the next start). The heartbeat keeps going in every state, so the beacon is healthy on the panel whether or not it is replaying; going live with it active and stopped shows the waiting-for-fix state on the tracker until Start is pressed.

**Transient flight-load failures.** A flight load that fails for a transient reason (the API unreachable, 408, 429, or a 5xx) keeps the run at `loading` with the reason in `lastError` and is retried on the beacon's backoff (1000, 2000, 3000, 5000 ms, then 5000 ms forever). Only a permanent failure (no year, an invalid speed, an `ApiError` with a 4xx status other than 408 and 429, or a flight with no published points) fails the run.

**A missing year is permanent.** When `GET /admin/events` holds no event for the run's year (the cache's `unknown_year`), the load is not retried: the run goes to `failed` with `lastError` `no event for year <year>` and the retry state resets. While a run is `running`, and while it is `stopped` with a year on the run, the leader checks at most once every 60 s (counted from the last check or the last successful load) that the event listing still holds an event for the run's year. The check runs beside the tick and never delays it. When the year is gone the run stops with status `failed`, `lastError` `no event for year <year>`, and the cached flight for that year is dropped. A failed check (the API unreachable, 408, 429, a 5xx, or any other error) changes nothing and is tried again at the next 60 s mark.

---

## 5. The control surface

**Auth.** The control API accepts `Authorization: Bearer <id-token>` from the admin pool: `iss` is `SIM_COGNITO_ISSUER`, `aud` one of `SIM_COGNITO_CLIENT_IDS`, `token_use` `id`, signature from the pool's JWKS (`jose` `createRemoteJWKSet`, cached), `cognito:groups` contains `SIM_ADMIN_GROUP`. Anything else is `401` or `403` with the contracts' error shape. There is no TOTP check here; the pool's own sign-in with TOTP is what the page goes through. CORS for the exact origins in `SIM_CORS_ORIGINS`, methods `GET, POST`, header `Authorization, Content-Type`.

| Method and path | Body | Success | Errors |
|---|---|---|---|
| `GET /api/health` | | `200 { "status": "ok", "leader": bool }` | `503` before the state document and the leader poll are ready |
| `GET /control/state` | | `200 { run: SimRun, beacon: { name, isActive, liveEventId, socketState, lastDeliveredSeqLocal, lastReceiptLatencyMs, heartbeatAge, revoked }, leaderInstance: string \| null }` (the beacon part is the leader's state, read from the document's `leader` where the leader writes it about once a second; null fields when no leader has reported in 10 s). `run.index`, `run.cycles`, and `run.nextFixInMs` come from `leader.state.run` when `leader.at` is within 10 s so the state follows the scheduler within a second; otherwise they fall back to the run (`nextFixInMs` is null) | |
| `GET /control/years` | | `200 { items: [ { year, eventId, name, pointCount } ] }` newest first | `502` when the WMSFO API refused |
| `GET /control/flight?year=YYYY` | | `200 { year, eventId, name, pointCount, firstRecordedAt, lastRecordedAt, durationMs, hasAltitude, speedSource, points: [ { i, t, lat, lng, speedMps, altitudeM } ] }`. `t` is milliseconds since the first point's `recordedAt`. `speedMps` is the recorded value when present, else derived: the haversine distance from the previous point divided by the seconds between the two `recordedAt` values (null for the first point and when the delta is not positive). `speedSource` is `"recorded"` when every non-null value was recorded, `"derived"` when every value was derived, `"mixed"` otherwise. `altitudeM` is the recorded value or null; `hasAltitude` is true when at least one point has one. The series is computed once per loaded year and kept with the cache entry. Every point is returned (the legacy years hold about 850 to 2,600 points; the page downsamples for drawing) | `400 validation_failed` (unknown year, non-integer year), `502 upstream_unavailable` (a cache load failure) |
| `POST /control/start` | `{ year, speed }` | `200 SimRun` (`status: "loading"`, then `running`). Keeps the run's `index` when the requested year equals the run's year and `0 <= index < total`, otherwise starts from 0 (a different year, `index == total` from a run that ended without loop, or out-of-range); Stop then Start therefore pauses and resumes | `400 validation_failed` (unknown year, speed not in the set), `409 already_running` |
| `POST /control/stop` | | `200 SimRun` (`stopped`, index kept) | |
| `POST /control/restart` | | `200 SimRun` (index 0, `running` with the current year and speed) | `409 no_run` |
| `PATCH /control/run` | `{ speed?, year?, loop?, index? }` (any subset) | `200 SimRun`: the run updated; while running the worker applies speed/year/loop within a quarter second (section 4: speed live, year from the first point, loop at the next end). `index` writes `seekTo` and `seekAt` on the run (section 4, seek and peek); the worker clamps to `total - 1` and acts on the next tick | `400 validation_failed` (unknown year, speed not in the set, non-integer or negative `index`), `409 no_run` (an `index` seek with no year on the run) |

```ts
type SimRun = { status: "stopped" | "loading" | "running" | "failed"; year: number | null; speed: number; loop: boolean; cycles: number; index: number; total: number;
                nextFixInMs: number | null; startedAt: string | null; lastFixAt: string | null; lastError: string | null; requestedBy: string | null; updatedAt: string };
```

**The page** (`web/`): sign in (one button, `signinRedirect` on the admin pool with the `wmsfo-simulator` client; the callback route; a "no role" line when the token has no `admin` group), then one card: the beacon line (name, Active or Spare, live event or "no live event", socket state, last delivered, receipt latency, heartbeat age, a red Revoked banner when set), the run line (status, year, speed, `index / total`, elapsed since `startedAt`, `run.nextFixInMs` when present), a timeline of the selected year, a year select from `GET /control/years`, a speed select (1x, 2x, 5x, 10x, 20x, 60x), a Loop switch, and Start (which reads "Resume" when the run is stopped mid-recording for the selected year, "Start" otherwise), Pause (the Stop button), Restart. The selects and the switch are never disabled: while a run is going, a change sends `PATCH /control/run` at once and the state line shows it take effect (the run line adds "cycle n" when `cycles` is above zero); while stopped the choice is what Start will use. The selects seed once from the run and keep the operator's choice across polls. The page polls `GET /control/state` every second while visible. **The timeline** (`Timeline.tsx`, an inline SVG that fills the card, about 200 px tall, plus a readout row): x is elapsed time from 0 to `durationMs` with ticks every 15 minutes labelled `h:mm`; the left y axis is speed in mph (`speedMps × 2.23694`) with round ticks and the legend `mph` (or `mph (derived)` when `speedSource == "derived"`); the right y axis is altitude in feet (`altitudeM × 3.28084`) with the legend `ft` when `hasAltitude`, otherwise no right axis and the legend reads `no altitude in this recording`. Two polylines (speed in the accent colour, altitude muted) are downsampled to at most one bucket per pixel column, keeping the bucket's min and max so a spike survives. A muted band marks the fastest 10 percent of points. A vertical playhead with a small handle follows `run.index` whenever `run.year` equals the selected year and the run has a total; hovering the chart shows a thin hover line and fills the readout row (`h:mm:ss`, mph, ft or `,  ft`, `point n of N`). Pointer down starts a drag: the playhead follows the pointer, the readout tracks it, and `PATCH /control/run { index }` is sent at most every 200 ms while dragging (trailing) and once more on release; a click without movement seeks once. With the chart focused (`tabIndex 0`, `role slider`, `aria-valuenow` the index, `aria-valuemax` `total - 1`), ArrowLeft and ArrowRight step one point, Shift+arrow steps ten, Home and End go to the ends, each sending one PATCH. Touch works through pointer events (`touch-action: none`). The flight for the selected year comes from `GET /control/flight` fetched once on load and on every year change, kept per-year in memory; a failure shows on the error line and the chart area reads `no flight loaded`. Styling: the site's token file copied (`tokens.css`, dark and light by `prefers-color-scheme`), Plex Sans and Mono, one frost card; no UI library, no chart library. Environment: `VITE_SIM_API_BASE_URL`, `VITE_COGNITO_AUTHORITY`, `VITE_COGNITO_DOMAIN`, `VITE_COGNITO_CLIENT_ID`; a missing value renders the configuration page. Local runs on `http://localhost:5175`.

---

## 6. State

The run lives in this beacon's state document, the one JSON object the WMSFO API keeps per beacon (`GET` and `PUT /beacons/me/state`, contracts 4.2 and 9.5). `service.ts` builds one `createStateStore` from `beacon-library` over the beacon's own REST client (`beacon.rest`, the `X-Beacon-Key` calls), and `stateDb.ts` (`createStateDb`) implements the `Db` interface of `runStore.ts` over it; the worker and the control routes talk to `Db` only. There is no database and nothing is migrated: the first boot on an empty document starts stopped.

```json
{
  "run": {
    "status": "stopped",
    "year": null,
    "speed": 1,
    "loop": true,
    "cycles": 0,
    "index": 0,
    "total": 0,
    "startedAt": null,
    "lastFixAt": null,
    "lastError": null,
    "requestedBy": null,
    "seekTo": null,
    "seekAt": null
  },
  "leader": { "state": null, "at": null }
}
```

| Field | Meaning |
|---|---|
| `run.status` | `stopped`, `loading`, `running`, or `failed` (section 4) |
| `run.year`, `run.speed`, `run.loop` | the year being replayed (null before the first Start), the speed in `{ 1, 2, 5, 10, 20, 60 }`, loop at the end |
| `run.cycles` | how many times the run has looped |
| `run.index`, `run.total` | the next point to send (the resume point) and the flight's point count |
| `run.startedAt`, `run.lastFixAt` | when the run last started, when the leader last sent a fix (rfc3339 or null) |
| `run.lastError` | why the run failed, or why a load is being retried |
| `run.requestedBy` | the operator who last started the run |
| `run.seekTo`, `run.seekAt` | a queued seek (section 4) and when it was asked for |
| `leader.state`, `leader.at` | the leader's beacon state for `GET /control/state` (`run` in it carries the live index, cycles, and next-fix delay) and when it was written |

`SimRun` (section 5) is `run` plus `leaderState` and `leaderAt` from `leader`, `updatedAt` from the document's `updatedAt`, and `nextFixInMs` null. Any other top-level key in the document survives every write: each write starts from the stored document and changes only `run` or `leader`.

**Writes.** Every write goes through the store: it is made with the version last read as `expectedVersion`, and a `409 state_version_conflict` makes the store read the document again, apply the same change to the fresh copy, and write again (up to five writes), so a control write and the leader's write landing together both survive.

- `init()` at boot loads the document; when it has no `run` it writes the defaults above with the version it read. When another node initialised first the write meets a conflict, the store rereads, and the run that is there is kept unchanged.
- `update(patch)` (the control routes and the worker's status changes) merges the patch into `run`.
- `writeLeaderState(state, progress)` sets `leader` to `{ state, at: now }` and, in the same write, the run's `index` and `lastFixAt` from the leader's progress, about once a second (section 2). The progress lands only while `run` is still `running` the same year, so a Stop, Start, Restart, or year change written on another node is never undone by it.
- `clearSeekAndSetIndex(i)` sets `seekTo` to null and `index` to `i`, and `dropSeek(i)` sets `seekTo` to null, each only when `run.seekTo` is `i`; when it is not, nothing is written. The version check makes the condition and the write one step: a newer seek written meanwhile fails the write, the store rereads, sees the newer value, and leaves it standing.

**Reads.** Each node keeps the store's last copy. `read()` answers from it and reloads first when the copy is older than 250 ms; one reload is in flight per node and concurrent reads share it. The leader's tick therefore reads at most every 250 ms, and a follower serving `GET /control/state` shares the same 250 ms copy, so page polls never add reads beyond that.

**Request budget.** The API allows 10 state reads and 10 state writes a second per beacon (burst 20). The leader reads at most four times a second and writes about once a second plus the status changes it makes; control writes come on top. A `429` on a read keeps the last copy (the next reload waits another 250 ms); a `429` on a write rejects that call, which the worker logs and makes again on a later tick, and which a control route answers as an error.

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
| `SIM_COGNITO_ISSUER`, `SIM_COGNITO_CLIENT_IDS`, `SIM_ADMIN_GROUP` | the admin pool, `wmsfo-simulator`, `admin` |
| `SIM_CORS_ORIGINS` | the control page origins, exact |
| `SIM_LOG_LEVEL` | `info` |
| `SIM_FORCE_LEADER` (optional) | local only, refused in prod |
| `GATEWAY_REALTIME_TOKEN` | injected by the gateway; used only for `/internal/leader` |

The app fails fast on a missing key, printing the key name and never the value. There is no database key: the run is in the beacon's state document, reached with `SIM_BEACON_KEY` (section 6); a `SIM_DB_CONNECTION` still present in the environment is ignored.

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

One manifest entry, `simulator-beacon-dev`, against the dev API: the simulator is never registered in prod, so there is no prod service. Image `simulator-beacon:<sha>-dev`, port 3000, secret per section 7, `includeInHealth` true, no realtime fields (platform.md 3.6). CI per platform.md 9.2a. `.github/workflows/deploy.yml` is the API's workflow with the names changed: a test job (`npm ci`, contracts check, typecheck, test, build; the web is built by Vercel, not here) and a deploy job gated on `push` to `dev` that assumes the OIDC role, logs into ECR, sets up QEMU and buildx, pushes a multi-platform image tagged `<ECR_REPOSITORY>:<sha>-<env>`, obtains a `mgmt/deploy` token, calls the gateway's deploy, and waits up to ten minutes for `done`. The dev environment carries the same secrets as the legacy beacon's (`AWS_ROLE_ARN`, `ECR_REPOSITORY`, `GATEWAY_BASE_URL`, `GATEWAY_TOKEN_URL`, `GATEWAY_CLIENT_ID`, `GATEWAY_CLIENT_SECRET`, `GATEWAY_SERVICE_NAME`) plus the variable `AWS_REGION`. The control page is one Vercel project on `web/` (platform.md 8), deployed from `main` at `<simulator-domain>`; there is no second, dev page. The prod admin pool does not exist yet, so the page and the service's token check use the dev admin pool. When the prod admin pool is created, create the `wmsfo-simulator` client on it and switch the page's `VITE_COGNITO_*` values and the service's `SIM_COGNITO_ISSUER` and `SIM_COGNITO_CLIENT_IDS` over to it (platform.md 18). Its API base URL is the gateway path form `https://<gateway-domain>/simulator-beacon-dev` (an operator tool needs no host of its own). First run: mint the API key and the beacon in the panel, write the secret, upsert the manifest entry from the dashboard, deploy, enrol nothing (the beacon key is in the secret), activate the beacon when a replay should reach the tracker.

---

## 10. Local development

A local run needs no database and no compose stack: the run is in the beacon's state document on the dev API (section 6). `.env.local` carries the dev keys with `SIM_FORCE_LEADER=true` and `SIM_GATEWAY_INTERNAL_URL=http://localhost:1`; the beacon and API keys point at the dev API, so a local run replays into dev exactly as the fleet would (activate the local beacon in the panel, or leave it a spare to watch the stored-but-unpublished rows). `web/` runs on 5175 against the local server.

---

## 11. Tests

The beacon core has its own suites in `beacon-library` and is not retested here. This repository tests the wiring on top of it and the parts particular to the simulator.

| Suite | Covers |
|---|---|
| `scheduler` | inter-point delays divided by speed, the 100 ms floor and 30 s ceiling, the first fix immediate, loop at the end (cycles counted) or stop when loop is off, a speed change re-timing the next delay without a restart, a year change restarting from the first point, restart from zero, `recordedAt` is now |
| `worker` | the index and `lastFixAt` written with the leader state on every fourth tick and never by a separate update; over the library's fake REST client, a run started on node A persists its index about every second and a worker on node B started over the same document resumes at that index; Stop pressed during the end-of-run await does not throw and the run ends stopped (a fake db whose `update` resolves after the stop); `leader.state.run` carries the live index and cycles after a loop restart; the 250 ms tick cadence with fake timers; the Start-resume rule in `controlRoutes`; seek while running re-arms the scheduler at the index and emits at once, seek while stopped emits exactly one point and stays stopped, the latest of three quick seeks wins, seek while failed is cleared without an emit; a load that throws `unknown_year` fails the run once with `no event for year <year>` and never retries while a 503 still retries on the backoff; the 60 s year check (fake timers) fails a running or stopped run whose year vanished and leaves a running run alone on a network error, 408, 429, or 5xx, trying again at the next mark |
| `flightRoute` | a three-point fixture with null recorded speeds derives the two speeds to within 1% of hand-computed haversine values, recorded speeds pass through, `hasAltitude` is false when every altitude is null, an unknown year 400, a cache load failure 502; the series and the sent fixes share one derivation (`segmentSpeedMps`) and one haversine |
| `service` | the default wiring reads and writes the run through `/beacons/me/state` with the beacon key and keeps other keys; the worker starts only after this node becomes leader and stops when it becomes follower; a fix the worker emits reaches the hub while connected; the heartbeat body validates against `contracts/schema/heartbeat.schema.json` and carries the same `debug` keys as section 8 |
| `flights/api` | paging follows `nextCursor`; `publishedOnly`; a `401` from the API marks the run failed with the code |
| `flights/cache` | the listing counts published locations for a year and drops years with none; a refresh whose event listing no longer holds a year drops it from the listing and the cache; `hasYear` answers from the event listing and drops a vanished year; `loadYear` for a vanished year drops its cached flight; the loaded points carry the filled headings and, for a recording with null speeds, numeric speeds that match the series |
| `flights/fill` | a recorded heading passes through untouched; a straight eastward run of points 100 m apart derives 90 to within 0.5 degrees at every point, the first from the point ahead; a point within 15 m of its predecessor takes the bearing from the earlier point at least 15 m back; a single point and a recording that never moves 15 m keep null; the output is new rows and the input is unchanged; no heading outside [0, 360); a recorded speed passes through untouched; a straight run of points 100 m and 10 s apart derives 10.0 at every point, the first from the segment ahead; a point with the same `recordedAt` as the previous one keeps null; a single point keeps null; the speed fill returns new rows and leaves the input unchanged; the filled speeds equal the series speeds to the digit |
| `config` | every SIM_* key validated; `SIM_FORCE_LEADER` refused in prod; `SIM_DB_CONNECTION` not required and ignored when present |
| `stateDb` | over the library's `createFakeRest` with a versioned document: init on an empty document writes the defaults (the run's shape and default values), init keeps a run already there, two nodes initialising together leave one run; update merges; writeLeaderState and a concurrent control update on another node both land, and the leader's progress does not undo a Restart; clearSeekAndSetIndex and dropSeek act only on a matching `seekTo` and a newer seek survives; reads within 250 ms share one fetch; a 429 on a read keeps the last copy and a 429 on a write rejects; unknown top-level keys survive |
| `control/routes` | every code in section 5 against a fake `Db`; the Start-resume rule (same year keeps the run's `index` when in range, otherwise 0; `index == total` starts from 0); `GET /control/state` reads `run.index`, `run.cycles`, and `run.nextFixInMs` from `leaderState.run` when fresh, else from the run; `PATCH /control/run { index }` writes `seekTo`/`seekAt` and returns the state body, 409 no_run without a year on the run, 400 for a non-integer or negative `index` |
| `timelineMath` and `Timeline` | `indexToX` and `xToIndex` round-trip within one point across the width; downsampling keeps the max of a bucket so a spike survives; hover fills the readout row; a drag of three pointer moves inside 200 ms sends one trailing `PATCH /control/run { index }` plus one on release with the released index; ArrowRight sends `index + 1` and Shift+ArrowRight `index + 10`; Home and End go to the ends; the empty-flight fallback reads `no flight loaded`; the button labels flip per the rule (Resume when stopped mid-recording for the selected year, Start otherwise; Pause always) |
| `ControlPanel` (flight fetch) | fetches `GET /control/flight` on load and on every year change; a fetch failure shows the message on the error line and the chart reads `no flight loaded` |
| Playwright (dev) | sign in through the admin pool, pick 2025 at 60x, Start, the state shows `running` with a rising index, the dev CDN `live/location.json` moves within 5 s while the dev event is live and this beacon is active, Stop; a second spec drags the playhead to the middle of the chart and expects `run.index` within 5% of half the total inside 2 s, then Pause and expects the status stopped with the index kept |

---

## 12. Decisions made here

- The simulator is a fleet service gated on `/internal/leader`, not a single container, so it deploys like everything else; its shared state is the run in its own beacon state document (section 6).
- Flights come from the WMSFO API through an `events`-capability API key, never from the API's database or the CDN.
- The simulator is a test beacon and is never registered in prod: one fleet service against the dev API and one control page from `main`. The page signs operators in through the dev admin pool until the prod admin pool exists (section 9).
- Replay preserves the recording's timing divided by the chosen speed, clamped to 100 ms and 30 s; `recordedAt` is the send time; a run stops at the end and restarts from the first point.
- The control page signs in through the admin pool with its own client and requires the `admin` group; the server checks the ID token itself and never calls the WMSFO API on the operator's behalf.
- One page, no UI library, the site's tokens copied in.
- Both Node beacons on the fleet, this one and the legacy beacon, are built on `beacon-library`.
- A run loops by default and every control applies while it runs; the run in the state document is the only source of truth and the worker follows it on its 250 ms tick.
- A seek is a field on the run (`seekTo`) the worker clears on the next tick, not an in-process call, so it works on whichever node took the request; the leader on the other node reads `seekTo` on its 250 ms tick and acts.
- The run lives in the API's beacon state document (contracts 4.2 and 9.5), read and written through `beacon-library`'s state store, not in a database of the simulator's own; the leader writes its index with its leader state about once a second so a new leader resumes within about a second of the last fix (Ben, 2026-10-18).
- The simulator fills the headings and the speeds the recordings lack, at load, as a real beacon would report them; the speed is the recording's own, never scaled by the replay speed; the API's derived values stay a fallback for fixes without them (Ben, 2026-10-27).

## 13. Needs a decision

Nothing at the moment. Add here as it comes up.
