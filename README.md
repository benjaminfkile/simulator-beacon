# simulator-beacon

The WMSFO v2 simulator beacon: an enrolled beacon that replays a past year's recorded flight at a chosen speed so a dev event set live shows a whole flight on the tracker. A Node and TypeScript service on the fleet behind the gateway, plus a one-page control site on Vercel that signs in through the admin Cognito pool.

Read `docs/` before touching anything:

- `docs/simulator-beacon.md`: this repository's technical design.
- `docs/DESIGN.md`: the design overview for all of v2 (a copy; the original is in `wmsfo-api/docs`).
- `docs/contracts.md`: the shared contracts every component codes against (a copy; wins on any conflict). Section 9 is the beacon contract.

## Run, test, build

Requires Node 22 or newer. In the root (the service) and again in `web/` (the control page): `npm ci`, then `npm test`, `npm run typecheck`, `npm run build`. `npm run contracts:check` in the root verifies `contracts/` against `wmsfo-api` at the pinned `CONTRACTS_SHA`. A local run against dev uses `SIM_FORCE_LEADER=true`; `docs/simulator-beacon.md` section 10 has the recipe and section 7 the configuration keys.
